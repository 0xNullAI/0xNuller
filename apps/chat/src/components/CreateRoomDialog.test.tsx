import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CreateRoomDialog } from './CreateRoomDialog';
afterEach(cleanup);
it('requires a manually entered name before creating a room', () => {
  const onCreate = vi.fn();
  render(<CreateRoomDialog onCreate={onCreate} onJoin={vi.fn()} onClose={vi.fn()} />);
  const button = screen.getByRole('button', { name: '创建' }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  const input = screen.getByPlaceholderText('请输入 4–40 个字符的房间名');
  fireEvent.change(input, { target: { value: '  短  ' } });
  expect(button.disabled).toBe(true);
  fireEvent.change(input, { target: { value: '  周末聊天房间  ' } });
  fireEvent.click(button);
  expect(onCreate).toHaveBeenCalledWith(expect.any(String), {
    public: false,
    roomName: '周末聊天房间',
  });
});
