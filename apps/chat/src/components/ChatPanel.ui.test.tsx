import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatPanel } from './ChatPanel';

const mediaMocks = vi.hoisted(() => ({ startRecording: vi.fn(), compressImage: vi.fn() }));
vi.mock('../lib/media', async (importOriginal) => ({
  ...(await importOriginal()),
  startRecording: mediaMocks.startRecording,
  compressImage: mediaMocks.compressImage,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  mediaMocks.startRecording.mockReset();
  mediaMocks.compressImage.mockReset();
});

describe('聊天输入栏', () => {
  it('输入法候选确认不会误发送', () => {
    const onSend = vi.fn();
    render(
      <ChatPanel
        conversationId="test-room"
        messages={[]}
        onSend={onSend}
        onSendMedia={vi.fn(async () => undefined)}
      />,
    );
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '你好' } });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, isComposing: true });

    expect(onSend).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe('你好');
  });

  it('连接未接受消息时保留草稿并显示错误', () => {
    render(
      <ChatPanel
        conversationId="test-room"
        messages={[]}
        onSend={() => false}
        onSendMedia={vi.fn(async () => undefined)}
      />,
    );
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '稍后重试' } });
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }));

    expect((input as HTMLInputElement).value).toBe('稍后重试');
    expect(screen.getByRole('alert').textContent).toContain('尚未发送');
  });

  it('组件卸载时取消活动录音', async () => {
    const cancel = vi.fn();
    mediaMocks.startRecording.mockResolvedValue({
      cancel,
      stop: vi.fn(async () => ({ blob: new Blob(), durationMs: 1 })),
    });
    const view = render(
      <ChatPanel
        conversationId="test-room"
        messages={[]}
        onSend={vi.fn()}
        onSendMedia={vi.fn(async () => undefined)}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '发送语音' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '取消录音' })).toBeTruthy());

    view.unmount();
    expect(cancel).toHaveBeenCalledOnce();
  });
});

it('shows an optimistic Chat message as pending until the server confirms the same ID', () => {
  const message = {
    id: 'message-1',
    fromSelf: true,
    senderId: 'self',
    senderName: '我',
    text: '你好',
    timestamp: 1,
  };
  const props = { conversationId: 'test-room', onSend: vi.fn(), onSendMedia: vi.fn() };
  const view = render(<ChatPanel {...props} messages={[message]} />);
  expect(screen.getByText(/发送中…/)).toBeTruthy();
  view.rerender(<ChatPanel {...props} messages={[{ ...message, serverConfirmed: true }]} />);
  expect(screen.queryByText(/发送中…/)).toBeNull();
  expect(
    screen.getByText('你好').closest('[data-conversation-message]')?.getAttribute('data-own'),
  ).toBe('true');
});

it('only renders private DM media with the current socket capability', () => {
  const message = {
    id: 'private-photo',
    fromSelf: false,
    senderId: 'peer',
    senderName: '好友',
    text: '',
    timestamp: 1,
    media: { kind: 'image' as const, url: '/api/media/dm%3Aprivate/photo', mime: 'image/png' },
  };
  const props = { messages: [message], onSend: vi.fn(), onSendMedia: vi.fn(async () => undefined) };
  const view = render(<ChatPanel conversationId="test-room" {...props} privateMediaToken={null} />);
  expect(screen.queryByRole('img', { name: '图片' })).toBeNull();
  view.rerender(
    <ChatPanel conversationId="test-room" {...props} privateMediaToken="live-capability" />,
  );
  expect((screen.getByRole('img', { name: '图片' }) as HTMLImageElement).getAttribute('src')).toBe(
    '/api/media/dm%3Aprivate/photo?token=live-capability',
  );
  view.rerender(<ChatPanel conversationId="test-room" {...props} privateMediaToken={null} />);
  expect(screen.queryByRole('img', { name: '图片' })).toBeNull();
});

it('replies to the exact same-named AI and keeps the quote when sending is rejected', () => {
  const onSend = vi.fn(() => false);
  const source = {
    id: 'source',
    senderId: 'ai:second',
    senderName: '同名',
    text: '我们聊到这里',
    timestamp: 1,
    fromSelf: false,
  };
  render(
    <ChatPanel
      conversationId="test-room"
      messages={[source]}
      members={[
        { peerId: 'ai:room', name: '同名' },
        { peerId: 'ai:second', name: '同名' },
      ]}
      onSend={onSend}
      onSendMedia={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '回复 同名' }));
  expect(screen.getByText('· 将提醒该 AI')).toBeTruthy();
  const input = screen.getByRole<HTMLInputElement>('textbox');
  expect(input.disabled).toBe(false);
  fireEvent.change(input, { target: { value: '继续这个话题' } });
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  expect(onSend).toHaveBeenCalledWith(
    '继续这个话题',
    [{ peerId: 'ai:second', displayName: '同名' }],
    { id: 'source', senderId: 'ai:second', senderName: '同名', text: '我们聊到这里' },
  );
  expect(screen.getByRole('button', { name: '取消回复' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '取消回复' }));
  expect(screen.queryByRole('button', { name: '取消回复' })).toBeNull();
});

it('renders server replies for private chats without interpreting quoted markup', () => {
  render(
    <ChatPanel
      conversationId="test-room"
      messages={[
        {
          id: 'reply',
          senderId: 'peer',
          senderName: '朋友',
          text: '收到',
          timestamp: 1,
          fromSelf: false,
          replyTo: {
            id: 'source',
            senderId: 'me',
            senderName: '我',
            text: '<script>不能执行</script>',
          },
        },
      ]}
      onSend={vi.fn()}
      onSendMedia={vi.fn()}
    />,
  );
  expect(screen.getByText('<script>不能执行</script>')).toBeTruthy();
  expect(document.querySelector('script')).toBeNull();
});

const replySource = {
  id: 'source-media',
  senderId: 'ai:second',
  senderName: '伙伴',
  text: '上次计划',
  timestamp: 1,
  fromSelf: false,
};
it('sends a compressed image with the selected quote and clears the quote only after success', async () => {
  const blob = new Blob(['photo'], { type: 'image/jpeg' });
  mediaMocks.compressImage.mockResolvedValue({ blob, w: 100, h: 80 });
  const send = vi.fn(async () => {});
  const view = render(
    <ChatPanel
      conversationId="test-room"
      messages={[replySource]}
      members={[{ peerId: 'ai:second', name: '伙伴' }]}
      onSend={vi.fn()}
      onSendMedia={send}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '回复 伙伴' }));
  fireEvent.click(screen.getByRole('button', { name: '更多' }));
  expect((screen.getByRole('menuitem', { name: '发送图片' }) as HTMLButtonElement).disabled).toBe(
    false,
  );
  fireEvent.change(view.container.querySelector('input[type=file]')!, {
    target: { files: [new File(['photo'], 'photo.jpg', { type: 'image/jpeg' })] },
  });
  await waitFor(() =>
    expect(send).toHaveBeenCalledWith(
      blob,
      'image',
      { w: 100, h: 80 },
      {
        replyTo: {
          id: 'source-media',
          senderId: 'ai:second',
          senderName: '伙伴',
          text: '上次计划',
        },
        mentions: [{ peerId: 'ai:second', displayName: '伙伴' }],
      },
    ),
  );
  expect(screen.queryByRole('button', { name: '取消回复' })).toBeNull();
});
it('previews a voice reply locally and preserves the exact quote after a failed confirmed send', async () => {
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL() {
        return 'blob:voice-preview';
      }
      static revokeObjectURL() {}
    },
  );
  const blob = new Blob(['voice'], { type: 'audio/webm' });
  mediaMocks.startRecording.mockResolvedValue({
    cancel: vi.fn(),
    stop: async () => ({ blob, durationMs: 1200 }),
  });
  const send = vi.fn(async () => {
    throw new Error('offline');
  });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  render(
    <ChatPanel
      conversationId="test-room"
      messages={[replySource]}
      onSend={vi.fn()}
      onSendMedia={send}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '回复 伙伴' }));
  fireEvent.click(screen.getByRole('button', { name: '发送语音' }));
  const stop = await screen.findByRole('button', { name: '结束录音' });
  expect((screen.getByRole('button', { name: '取消回复' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.click(stop);
  expect(await screen.findByText('录音待发送')).toBeTruthy();
  expect(send).not.toHaveBeenCalled();
  expect(screen.getByLabelText('待发送语音预览')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '确认发送语音' }));
  await screen.findByText('语音发送失败，请重试');
  expect(send).toHaveBeenCalledWith(
    blob,
    'audio',
    { durationMs: 1200 },
    { replyTo: expect.objectContaining({ id: 'source-media' }), mentions: [] },
  );
  expect(screen.getByRole('button', { name: '取消回复' })).toBeTruthy();
  expect(screen.getByText('录音待发送')).toBeTruthy();
  expect((screen.getByRole('button', { name: '发送语音' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  log.mockRestore();
});
it('retries the same completed voice recording and exact reply without recording again', async () => {
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL() {
        return 'blob:voice-preview';
      }
      static revokeObjectURL() {}
    },
  );
  const blob = new Blob(['voice'], { type: 'audio/webm' });
  const stop = vi.fn(async () => ({ blob, durationMs: 1200 }));
  mediaMocks.startRecording.mockResolvedValue({ cancel: vi.fn(), stop });
  const send = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  render(
    <ChatPanel
      conversationId="test-room"
      messages={[replySource]}
      onSend={vi.fn()}
      onSendMedia={send}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '回复 伙伴' }));
  fireEvent.click(screen.getByRole('button', { name: '发送语音' }));
  fireEvent.click(await screen.findByRole('button', { name: '结束录音' }));
  await screen.findByText('录音待发送');
  fireEvent.click(screen.getByRole('button', { name: '确认发送语音' }));
  await screen.findByText('语音发送失败，请重试');
  fireEvent.click(screen.getByRole('button', { name: '重试发送附件' }));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
  expect(stop).toHaveBeenCalledOnce();
  await waitFor(() => expect(screen.queryByText('录音待发送')).toBeNull());
  expect(screen.queryByRole('button', { name: '取消回复' })).toBeNull();
  log.mockRestore();
});
it('discards an unsent voice preview without uploading it', async () => {
  const revoke = vi.fn();
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL() {
        return 'blob:voice-preview';
      }
      static revokeObjectURL = revoke;
    },
  );
  mediaMocks.startRecording.mockResolvedValue({
    cancel: vi.fn(),
    stop: vi.fn(async () => ({
      blob: new Blob(['voice'], { type: 'audio/webm' }),
      durationMs: 800,
    })),
  });
  const send = vi.fn();
  render(
    <ChatPanel conversationId="test-room" messages={[]} onSend={vi.fn()} onSendMedia={send} />,
  );
  fireEvent.click(screen.getByRole('button', { name: '发送语音' }));
  fireEvent.click(await screen.findByRole('button', { name: '结束录音' }));
  expect(await screen.findByText('录音待发送')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '丢弃附件' }));
  expect(send).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('待发送语音预览')).toBeNull();
  expect(revoke).toHaveBeenCalledWith('blob:voice-preview');
});
it('keeps a prepared image for retry and clears it when discarded', async () => {
  const blob = new Blob(['photo'], { type: 'image/jpeg' });
  mediaMocks.compressImage.mockResolvedValue({ blob, w: 100, h: 80 });
  const send = vi.fn(async () => {
    throw new Error('offline');
  });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const view = render(
    <ChatPanel conversationId="test-room" messages={[]} onSend={vi.fn()} onSendMedia={send} />,
  );
  fireEvent.change(view.container.querySelector('input[type=file]')!, {
    target: { files: [new File(['photo'], 'photo.jpg', { type: 'image/jpeg' })] },
  });
  await screen.findByText('图片待发送');
  fireEvent.click(screen.getByRole('button', { name: '重试发送附件' }));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
  expect(mediaMocks.compressImage).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: '丢弃附件' }));
  expect(screen.queryByText('图片待发送')).toBeNull();
  log.mockRestore();
});
it('discards image preparation when the old conversation composer unmounts', async () => {
  let finish!: (value: { blob: Blob; w: number; h: number }) => void;
  mediaMocks.compressImage.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const send = vi.fn();
  const view = render(
    <ChatPanel
      conversationId="test-room"
      messages={[replySource]}
      onSend={vi.fn()}
      onSendMedia={send}
    />,
  );
  fireEvent.change(view.container.querySelector('input[type=file]')!, {
    target: { files: [new File(['x'], 'photo.jpg')] },
  });
  view.unmount();
  finish({ blob: new Blob(['x']), w: 1, h: 1 });
  await Promise.resolve();
  await Promise.resolve();
  expect(send).not.toHaveBeenCalled();
});
it('locates a quoted source only in messages already loaded for the current conversation', () => {
  const quote = {
    id: 'response',
    senderId: 'user',
    senderName: '用户',
    text: '好',
    timestamp: 2,
    fromSelf: true,
    replyTo: {
      id: replySource.id,
      senderId: replySource.senderId,
      senderName: replySource.senderName,
      text: replySource.text,
    },
  };
  const view = render(
    <ChatPanel
      conversationId="test-room"
      messages={[replySource, quote]}
      onSend={vi.fn()}
      onSendMedia={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '定位 伙伴 的原消息' }));
  expect(document.activeElement).toBe(
    view.container.querySelector('[data-message-id="source-media"]'),
  );
  view.rerender(
    <ChatPanel
      conversationId="test-room"
      messages={[quote]}
      onSend={vi.fn()}
      onSendMedia={vi.fn()}
    />,
  );
  expect(
    (screen.getByRole('button', { name: '定位 伙伴 的原消息' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});
