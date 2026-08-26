import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ShellRoomList } from './ShellRoomList';

vi.mock('../lib/lobby-client', () => ({
  fetchLobbyRooms: vi.fn(async () => [
    { code: 'room-a', name: '公开房间 A', count: 2 },
    { code: 'room-b', name: '公开房间 B', count: 0 },
  ]),
  subscribeLobby: vi.fn(() => ({ close: vi.fn() })),
}));

vi.mock('../lib/groups', () => ({
  forgetGroup: vi.fn(),
  GROUPS_CHANGED_EVENT: 'test:groups-changed',
  loadKnownGroups: vi.fn(() => []),
  syncKnownGroups: vi.fn(async () => []),
}));

afterEach(cleanup);

describe('侧栏公开房间目录', () => {
  it('默认收起，展开后限高滚动并仍可加入房间', async () => {
    const onJoin = vi.fn();
    render(
      <ShellRoomList currentRoom={null} onJoin={onJoin} onCreate={vi.fn()} onDelete={vi.fn()} />,
    );

    const toggle = await screen.findByRole('button', { name: '显示公开房间（2）' });
    const directory = document.getElementById(toggle.getAttribute('aria-controls') ?? '');

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(directory?.hidden).toBe(true);

    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(directory?.hidden).toBe(false);
    expect(directory?.className).toContain('max-h-64');
    expect(directory?.className).toContain('overflow-y-auto');

    fireEvent.click(screen.getByRole('button', { name: /公开房间 A/ }));
    await waitFor(() => expect(onJoin).toHaveBeenCalledWith('room-a'));
  });

  it('主内容区的公开目录默认展开，但仍可隐藏', async () => {
    render(
      <ShellRoomList
        mode="directory"
        currentRoom={null}
        onJoin={vi.fn()}
        onCreate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    const toggle = await screen.findByRole('button', { name: '隐藏公开房间（2）' });
    const directory = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    expect(directory?.hidden).toBe(false);

    fireEvent.click(toggle);
    expect(directory?.hidden).toBe(true);
  });
});
