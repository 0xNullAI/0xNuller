import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CreateRoomDialog } from './CreateRoomDialog';
afterEach(cleanup);

it('creates a room with a valid default name and never puts the room code in it', () => {
  const onCreate = vi.fn();
  render(
    <CreateRoomDialog ownerName="小雨" onCreate={onCreate} onJoin={vi.fn()} onClose={vi.fn()} />,
  );
  const input = screen.getByPlaceholderText('4–40 个字符') as HTMLInputElement;
  expect(input.value).toBe('小雨的群聊');
  const button = screen.getByRole('button', { name: '创建' }) as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  const [code, options] = onCreate.mock.calls[0]!;
  expect(options).toEqual({ public: false, roomName: '小雨的群聊' });
  expect(options.roomName).not.toContain(String(code).slice(0, 4));
});

it('falls back to a valid default without a nickname and keeps the 4–40 rule for edits', () => {
  const onCreate = vi.fn();
  render(<CreateRoomDialog onCreate={onCreate} onJoin={vi.fn()} onClose={vi.fn()} />);
  const input = screen.getByPlaceholderText('4–40 个字符') as HTMLInputElement;
  expect(input.value).toMatch(/^新群聊 \d{4}$/);
  const button = screen.getByRole('button', { name: '创建' }) as HTMLButtonElement;
  fireEvent.change(input, { target: { value: '  短  ' } });
  expect(button.disabled).toBe(true);
  fireEvent.change(input, { target: { value: '  周末聊天房间  ' } });
  fireEvent.click(button);
  expect(onCreate).toHaveBeenCalledWith(expect.any(String), {
    public: false,
    roomName: '周末聊天房间',
  });
});
