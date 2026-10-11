// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { createEmptyDeviceState, createEmptySensorState } from '@dg-agent/core';
import { createEmptyOpossumState } from '@dg-kit/protocol';
import { ShellChromeProvider } from '@0xnullai/ui';
import { ChatPanel } from './ChatPanel.js';

const mediaApi = vi.hoisted(() => ({
  account: null as string | null,
  list: vi.fn(),
  attachments: vi.fn().mockResolvedValue([]),
  upload: vi.fn().mockResolvedValue({ id: 'saved' }),
}));
vi.mock('@0xnullai/auth', () => ({
  currentAuthUserId: () => mediaApi.account,
  subscribeAuthChanges: () => () => undefined,
  listMediaJobs: mediaApi.list,
  mediaJobBlob: vi.fn(),
  PrivateConversationAttachmentChannel: class {
    list = mediaApi.attachments;
    upload = mediaApi.upload;
    dispose = vi.fn();
  },
  PrivateConversationChannel: class {
    ensure = vi.fn().mockResolvedValue(undefined);
    dispose = vi.fn();
  },
}));

afterEach(() => {
  cleanup();
  mediaApi.list.mockReset();
  mediaApi.attachments.mockReset().mockResolvedValue([]);
  mediaApi.upload.mockReset().mockResolvedValue({ id: 'saved' });
  mediaApi.account = null;
  vi.unstubAllGlobals();
});

function makeProps(): ComponentProps<typeof ChatPanel> {
  const noop = () => undefined;
  return {
    accountId: null,
    activeSessionId: 's',
    text: '',
    statusMessage: null,
    onTextChange: noop,
    onAbortReply: noop,
    onToggleVoiceMode: noop,
    onSend: noop,
    onAskImage: noop,
    imageInputSupported: false,
    busy: false,
    speechRecognitionEnabled: false,
    voiceMode: false,
    voiceState: 'idle',
    speechRecognitionSupported: false,
    session: {
      id: 's',
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      deviceState: createEmptyDeviceState(),
    },
    onLoadEarlier: vi.fn().mockResolvedValue(undefined),
    observedSequence: null,
    onTranscriptTailVisibilityChange: noop,
    traceFeed: [],
    streamingAssistantText: '',
    deviceState: createEmptyDeviceState(),
    maxStrengthA: 10,
    maxStrengthB: 10,
    opossumState: createEmptyOpossumState(),
    maxOpossumIntensityA: 10,
    maxOpossumIntensityB: 10,
    pawPrintsState: createEmptySensorState(),
    civetEdgingState: createEmptySensorState(),
    onConnect: noop,
    onEmergencyStop: noop,
    onOpenSidebar: noop,
    onOpenSettings: noop,
    promptPresetId: 'character',
    savedPresets: [
      { id: 'character', kind: 'character', name: '小岚', prompt: '人设' },
      { id: 'forest', kind: 'scene', name: '森林', prompt: '环境' },
      { id: 'city', kind: 'scene', name: '城市', prompt: '环境' },
    ],
    coyoteTargets: [],
    activeCoyoteId: null,
    onCoyoteTargetChange: noop,
  };
}

it('groups AI chat attachments, call, camera and generation in one composer menu', () => {
  const props = makeProps();
  props.accountId = 'alice';
  props.onVoiceCall = vi.fn();
  props.onCamera = vi.fn();
  props.onGenerateMedia = vi.fn();
  const view = render(
    <ShellChromeProvider openSettings={() => undefined} signedIn>
      <ChatPanel {...props} />
    </ShellChromeProvider>,
  );
  expect(screen.queryByRole('button', { name: '语音通话' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '添加聊天内容' }));
  expect(screen.getByRole('menu', { name: '聊天能力' })).toBeTruthy();
  expect(screen.getByRole('menuitem', { name: '发送图片' })).toBeTruthy();
  expect(screen.getByRole('menuitem', { name: '录制语音' })).toBeTruthy();
  fireEvent.click(screen.getByRole('menuitem', { name: '语音通话' }));
  expect(props.onVoiceCall).toHaveBeenCalledOnce();
  expect(screen.queryByRole('menu', { name: '聊天能力' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '添加聊天内容' }));
  fireEvent.click(screen.getByRole('menuitem', { name: '摄像头观察' }));
  expect(props.onCamera).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: '添加聊天内容' }));
  fireEvent.click(screen.getByRole('menuitem', { name: '生成图片或视频' }));
  expect(props.onGenerateMedia).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: '添加聊天内容' }));
  view.rerender(
    <ShellChromeProvider openSettings={() => undefined} signedIn>
      <ChatPanel {...props} accountId="bob" />
    </ShellChromeProvider>,
  );
  expect(screen.queryByRole('menu', { name: '聊天能力' })).toBeNull();
});

it('shows private media jobs in the same timeline and hides the previous account immediately', async () => {
  const mediaJob = (prompt: string) => ({
    id: prompt,
    kind: 'image' as const,
    conversationId: 's',
    relationshipId: 'r',
    prompt,
    state: 'processing',
    credits: 10,
    priceVersion: 'test',
    photoId: null,
    contentUrl: null,
    lastError: null,
    createdAt: 2,
    updatedAt: 2,
  });
  mediaApi.list.mockResolvedValue({ items: [mediaJob('Alice 的图片')] });
  const props = { ...makeProps(), accountId: 'alice' };
  const view = render(
    <ShellChromeProvider openSettings={() => undefined} signedIn>
      <ChatPanel {...props} />
    </ShellChromeProvider>,
  );
  expect(await screen.findByText('Alice 的图片')).toBeTruthy();

  mediaApi.list.mockResolvedValue({ items: [mediaJob('Bob 的图片')] });
  view.rerender(
    <ShellChromeProvider openSettings={() => undefined} signedIn>
      <ChatPanel {...props} accountId="bob" />
    </ShellChromeProvider>,
  );
  expect(screen.queryByText('Alice 的图片')).toBeNull();
  expect(await screen.findByText('Bob 的图片')).toBeTruthy();

  mediaApi.list.mockResolvedValue({ items: [mediaJob('Bob 的新图片')] });
  window.dispatchEvent(
    new CustomEvent('0xnullai:media-jobs-changed', { detail: { conversationId: 's' } }),
  );
  expect(await screen.findByText('Bob 的新图片')).toBeTruthy();
});

it('does not present old fake model text as an executed device command', () => {
  const props = makeProps();
  props.session!.messages = [
    {
      id: 'old-fake',
      role: 'assistant',
      content: 'Fake LLM 已完成工具执行：{"command":{"type":"start"}}',
      createdAt: 3,
    },
  ];
  render(
    <ShellChromeProvider openSettings={() => undefined} signedIn>
      <ChatPanel {...props} />
    </ShellChromeProvider>,
  );
  expect(screen.getByText('旧版模型文字未核验工具执行，请查看设备状态。')).toBeTruthy();
  expect(screen.queryByText(/已执行启动指令/)).toBeNull();
});

it('keeps server message order and distinguishes an optimistic user row from saved history', () => {
  const props = makeProps();
  props.session!.messages = [
    { id: 'first', role: 'user', content: '第一条', createdAt: 900, serverConfirmed: false },
    { id: 'second', role: 'assistant', content: '第二条', createdAt: 1, serverConfirmed: true },
  ];
  const view = render(
    <ShellChromeProvider openSettings={() => undefined} signedIn>
      <ChatPanel {...props} />
    </ShellChromeProvider>,
  );
  expect(
    screen.getByText('第一条').compareDocumentPosition(screen.getByText('第二条')) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(screen.getByText('正在同步…')).toBeTruthy();
  view.rerender(
    <ShellChromeProvider openSettings={() => undefined} signedIn>
      <ChatPanel
        {...props}
        session={{
          ...props.session!,
          messages: props.session!.messages.map((message) => ({
            ...message,
            serverConfirmed: true,
          })),
        }}
      />
    </ShellChromeProvider>,
  );
  expect(screen.queryByText('正在同步…')).toBeNull();
});

it('renders saved AI and user text in the shared chat rows with character identity', () => {
  const props = makeProps();
  props.session!.messages = [
    { id: 'u', role: 'user', content: '你好', createdAt: 1 },
    { id: 'a', role: 'assistant', content: '晚上好', createdAt: 2 },
  ];
  render(
    <ShellChromeProvider openSettings={() => undefined} signedIn>
      <ChatPanel {...props} />
    </ShellChromeProvider>,
  );
  expect(
    screen.getByText('你好').closest('[data-conversation-message]')?.getAttribute('data-own'),
  ).toBe('true');
  expect(
    screen.getByText('晚上好').closest('[data-conversation-message]')?.getAttribute('data-own'),
  ).toBeNull();
  expect(screen.getByTitle('小岚')).toBeTruthy();
});

it('requests earlier server messages with the display window cursor', () => {
  const props = makeProps();
  props.session = {
    ...props.session!,
    messages: [{ id: 'recent', role: 'user', content: '最近消息', createdAt: 2 }],
    historyWindow: { nextBefore: 42 },
  };
  render(
    <ShellChromeProvider openSettings={() => undefined} signedIn>
      <ChatPanel {...props} />
    </ShellChromeProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: '加载更早消息' }));
  expect(props.onLoadEarlier).toHaveBeenCalledWith('s', 42);
});

it('only offers explicit image understanding for a declared vision model', async () => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const attachment = {
    id: 'image-1',
    messageId: 'message-1',
    kind: 'image' as const,
    mime: 'image/png',
    size: 4,
    createdAt: 2,
    contentUrl: '/private/image-1',
  };
  mediaApi.attachments.mockResolvedValue([attachment]);
  const onAskImage = vi.fn();
  const props = { ...makeProps(), accountId: 'alice', onAskImage };
  const view = render(
    <ShellChromeProvider openSettings={() => undefined} signedIn>
      <ChatPanel {...props} />
    </ShellChromeProvider>,
  );
  expect(await screen.findByText('图片已保存 · 仅在明确请求时交给 AI')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '让 AI 看图' })).toBeNull();
  view.rerender(
    <ShellChromeProvider openSettings={() => undefined} signedIn>
      <ChatPanel {...props} imageInputSupported />
    </ShellChromeProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: '让 AI 看图' }));
  expect(onAskImage).toHaveBeenCalledWith(attachment);
});

it('shows user-authored voice text on the attachment without duplicating its server message', async () => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  mediaApi.attachments.mockResolvedValue([
    {
      id: 'voice-1',
      messageId: 'attachment-voice-1',
      kind: 'voice',
      mime: 'audio/ogg',
      size: 8,
      createdAt: 2,
      contentUrl: '/private/voice-1',
      caption: '今晚聊小猫',
    },
  ]);
  const onReplyToVoice = vi.fn();
  const props = { ...makeProps(), accountId: 'alice', onReplyToVoice };
  props.session!.messages = [
    {
      id: 'attachment-voice-1',
      role: 'user',
      content: '用户为语音附上的文字（未自动核对音频）：今晚聊小猫',
      createdAt: 2,
    },
  ];
  render(
    <ShellChromeProvider openSettings={() => undefined} signedIn>
      <ChatPanel {...props} />
    </ShellChromeProvider>,
  );
  expect(await screen.findByText('今晚聊小猫')).toBeTruthy();
  expect(screen.getByText('用户附上的文字可供 AI 阅读；录音尚未自动转写')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '请 AI 回应文字' }));
  expect(onReplyToVoice).toHaveBeenCalledWith(expect.objectContaining({ id: 'voice-1' }));
  expect(screen.queryByText('用户为语音附上的文字（未自动核对音频）：今晚聊小猫')).toBeNull();
});

it('keeps a recording local until the user confirms its text and sends it', async () => {
  mediaApi.account = 'alice';
  const stream = { getTracks: () => [{ stop: vi.fn() }] };
  const originalDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
  });
  class FakeRecorder {
    static isTypeSupported(type: string) {
      return type === 'audio/ogg';
    }
    state = 'inactive';
    mimeType = 'audio/ogg';
    stream = stream;
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    start() {
      this.state = 'recording';
    }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['OggSvoice'], { type: 'audio/ogg' }) });
      this.onstop?.();
    }
  }
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL() {
        return 'blob:voice-preview';
      }
      static revokeObjectURL() {}
    },
  );
  try {
    render(
      <ShellChromeProvider openSettings={() => undefined} signedIn>
        <ChatPanel {...makeProps()} accountId="alice" />
      </ShellChromeProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '添加聊天内容' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '录制语音' }));
    await screen.findByRole('button', { name: '结束录音' });
    fireEvent.click(screen.getByRole('button', { name: '结束录音' }));
    expect(await screen.findByText('录音待发送')).toBeTruthy();
    expect(mediaApi.upload).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: '语音文字' }), {
      target: { value: '今晚聊小猫' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送语音和文字' }));
    await waitFor(() =>
      expect(mediaApi.upload).toHaveBeenCalledWith(expect.any(Blob), '今晚聊小猫'),
    );
    await waitFor(() => expect(screen.queryByText('录音待发送')).toBeNull());
  } finally {
    if (originalDevices) Object.defineProperty(navigator, 'mediaDevices', originalDevices);
    else Reflect.deleteProperty(navigator, 'mediaDevices');
  }
});

it('shows a failed reply as a page notice outside the saved messages', () => {
  const props = makeProps();
  const { rerender } = render(<ChatPanel {...props} failedReplyText="模型服务暂时不可用" />);
  expect(screen.getByRole('alert').textContent).toContain('模型服务暂时不可用');
  // A new reply in progress replaces the notice with the typing indicator.
  rerender(<ChatPanel {...props} busy failedReplyText="模型服务暂时不可用" />);
  expect(screen.queryByText('模型服务暂时不可用')).toBeNull();
});

it('asks for per-chat device consent above the composer only while a device is connected', () => {
  mediaApi.list.mockResolvedValue({ items: [] });
  const props = { ...makeProps(), accountId: 'alice' };
  const { rerender } = render(<ChatPanel {...props} />);
  expect(screen.queryByText('允许本聊天控制设备？')).toBeNull();
  rerender(<ChatPanel {...props} deviceState={{ ...createEmptyDeviceState(), connected: true }} />);
  expect(screen.getByText('允许本聊天控制设备？')).toBeTruthy();
});
