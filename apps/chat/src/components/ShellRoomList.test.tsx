import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ShellRoomList } from './ShellRoomList';

const accountState = vi.hoisted(() => ({
  id: null as string | null,
  listeners: new Set<() => void>(),
  pages: vi.fn(),
  migrate: vi.fn(async () => {}),
}));

vi.mock('@0xnullai/auth', () => ({
  currentAuthUserId: () => accountState.id,
  subscribeAuthChanges: (listener: () => void) => {
    accountState.listeners.add(listener);
    return () => accountState.listeners.delete(listener);
  },
}));
vi.mock('@0xnullai/sync', () => ({ pullChatRoomsPage: accountState.pages }));

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
  migrateLegacyKnownGroups: accountState.migrate,
}));

afterEach(cleanup);
beforeEach(() => {
  accountState.id = null;
  accountState.pages.mockReset();
  accountState.migrate.mockClear();
});

describe('侧栏公开房间目录', () => {
  it('默认收起，展开后限高滚动并仍可加入房间', async () => {
    const onJoin = vi.fn();
    render(
      <ShellRoomList currentRoom={null} onJoin={onJoin} onCreate={vi.fn()} onDelete={vi.fn()} />,
    );

    const toggle = await screen.findByRole('button', { name: '显示公开群（2）' });
    const directory = document.getElementById(toggle.getAttribute('aria-controls') ?? '');

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(directory?.hidden).toBe(true);

    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(directory?.hidden).toBe(false);
    expect(directory?.className).toContain('max-h-64');
    expect(directory?.className).toContain('overflow-y-auto');

    expect(screen.getByText('0 人在线')).toBeTruthy();
    expect(screen.getByText('2 人在线')).toBeTruthy();
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

    const toggle = await screen.findByRole('button', { name: '隐藏公开群（2）' });
    const directory = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    expect(directory?.hidden).toBe(false);

    fireEvent.click(toggle);
    expect(directory?.hidden).toBe(true);
  });
});

describe('账号群聊分页', () => {
  it('only reads the first page until asked and retries a failed next page', async () => {
    accountState.id = 'alice';
    accountState.pages
      .mockResolvedValueOnce({ rooms: [{ code: 'a', name: '群 A' }], nextCursor: 'same-ms:a' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        rooms: [
          { code: 'a', name: '群 A' },
          { code: 'b', name: '群 B' },
        ],
        nextCursor: null,
      });
    render(
      <ShellRoomList currentRoom={null} onJoin={vi.fn()} onCreate={vi.fn()} onDelete={vi.fn()} />,
    );
    await screen.findByText('群 A');
    expect(accountState.pages).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '加载更多群聊' }));
    await screen.findByRole('button', { name: '重试加载群聊' });
    expect(screen.getByText('群 A')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重试加载群聊' }));
    await screen.findByText('群 B');
    expect(screen.getAllByText('群 A')).toHaveLength(1);
    expect(accountState.pages).toHaveBeenNthCalledWith(2, 'same-ms:a');
    expect(accountState.pages).toHaveBeenNthCalledWith(3, 'same-ms:a');
  });

  it('refreshes the pages already explored and removes a server-deleted group', async () => {
    accountState.id = 'alice';
    accountState.pages
      .mockResolvedValueOnce({ rooms: [{ code: 'a', name: '群 A' }], nextCursor: 'same-ms:a' })
      .mockResolvedValueOnce({ rooms: [{ code: 'b', name: '已删除群' }], nextCursor: null })
      .mockResolvedValueOnce({ rooms: [{ code: 'a', name: '群 A' }], nextCursor: null });
    render(
      <ShellRoomList currentRoom={null} onJoin={vi.fn()} onCreate={vi.fn()} onDelete={vi.fn()} />,
    );
    await screen.findByText('群 A');
    fireEvent.click(screen.getByRole('button', { name: '加载更多群聊' }));
    await screen.findByText('已删除群');
    await act(async () => window.dispatchEvent(new Event('test:groups-changed')));
    await waitFor(() => expect(screen.queryByText('已删除群')).toBeNull());
    expect(accountState.pages).toHaveBeenNthCalledWith(3, null);
  });

  it('discards late pages after an A-B-A transition and starts over for the current account', async () => {
    accountState.id = 'alice';
    let release: (value: unknown) => void = () => undefined;
    accountState.pages
      .mockResolvedValueOnce({ rooms: [{ code: 'a', name: '旧账号群' }], nextCursor: 'next' })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValueOnce({ rooms: [], nextCursor: null });
    render(
      <ShellRoomList currentRoom={null} onJoin={vi.fn()} onCreate={vi.fn()} onDelete={vi.fn()} />,
    );
    await screen.findByText('旧账号群');
    fireEvent.click(screen.getByRole('button', { name: '加载更多群聊' }));
    await act(async () => {
      accountState.id = 'bob';
      for (const listener of accountState.listeners) listener();
      accountState.id = 'alice';
      for (const listener of accountState.listeners) listener();
      release({ rooms: [{ code: 'secret', name: '不应出现' }], nextCursor: null });
    });
    await waitFor(() => expect(screen.queryByText('旧账号群')).toBeNull());
    expect(screen.queryByText('不应出现')).toBeNull();
  });
});
