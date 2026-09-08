import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatPanel } from './ChatPanel';

const mediaMocks = vi.hoisted(() => ({ startRecording: vi.fn() }));
vi.mock('../lib/media', async (importOriginal) => ({
  ...(await importOriginal()),
  startRecording: mediaMocks.startRecording,
}));

afterEach(cleanup);
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  mediaMocks.startRecording.mockReset();
});

describe('聊天输入栏', () => {
  it('图标操作都有可读名称', () => {
    render(<ChatPanel messages={[]} onSend={vi.fn()} onSendMedia={vi.fn(async () => undefined)} />);

    expect(screen.getByRole('button', { name: '发送图片' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '发送语音' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '发送消息' })).toBeTruthy();
  });

  it('输入法候选确认不会误发送', () => {
    const onSend = vi.fn();
    render(<ChatPanel messages={[]} onSend={onSend} onSendMedia={vi.fn(async () => undefined)} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '你好' } });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, isComposing: true });

    expect(onSend).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe('你好');
  });

  it('连接未接受消息时保留草稿并显示错误', () => {
    render(
      <ChatPanel messages={[]} onSend={() => false} onSendMedia={vi.fn(async () => undefined)} />,
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
      <ChatPanel messages={[]} onSend={vi.fn()} onSendMedia={vi.fn(async () => undefined)} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '发送语音' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '取消录音' })).toBeTruthy());

    view.unmount();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
