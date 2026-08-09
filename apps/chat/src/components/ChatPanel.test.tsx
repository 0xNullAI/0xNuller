import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ChatPanel } from './ChatPanel';

afterEach(cleanup);
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

describe('聊天输入栏', () => {
  it('图标操作都有可读名称', () => {
    render(
      <ChatPanel
        messages={[]}
        onSend={vi.fn()}
        onSendMedia={vi.fn(async () => undefined)}
      />,
    );

    expect(screen.getByRole('button', { name: '发送图片' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '发送语音' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '发送消息' })).toBeTruthy();
  });
});
