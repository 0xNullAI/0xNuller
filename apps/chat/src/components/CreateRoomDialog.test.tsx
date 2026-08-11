import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CreateRoomDialog } from './CreateRoomDialog';

afterEach(cleanup);

describe('新建或加入房间', () => {
  it('可以切换到加入并按房间号进入', () => {
    const onJoin = vi.fn();
    render(
      <CreateRoomDialog defaultName="测试" onCreate={vi.fn()} onJoin={onJoin} onClose={vi.fn()} />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '加入' }).at(-1)!);
    fireEvent.change(screen.getByPlaceholderText('输入房间号'), { target: { value: ' room-7 ' } });
    fireEvent.click(screen.getAllByRole('button', { name: '加入' }).at(-1)!);

    expect(onJoin).toHaveBeenCalledWith('room-7');
  });
});
