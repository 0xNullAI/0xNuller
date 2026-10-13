import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AuthUser } from '@0xnullai/auth';
import { ContactsDialog } from './ContactsDialog';

const state = vi.hoisted(() => ({
  contacts: vi.fn(),
  discover: vi.fn(),
  following: vi.fn(),
  followers: vi.fn(),
  blocks: vi.fn(),
  lookup: vi.fn(),
  dm: vi.fn(),
  profile: vi.fn(),
  follow: vi.fn(),
  unfollow: vi.fn(),
  removeFollower: vi.fn(),
  unblock: vi.fn(),
}));

vi.mock('@0xnullai/auth', () => ({
  listContacts: state.contacts,
  listDiscoverableUsers: state.discover,
  listFollowing: state.following,
  listFollowers: state.followers,
  listBlocks: state.blocks,
  getUser: state.lookup,
  openDirectMessage: state.dm,
  requestProfileView: state.profile,
  avatarSrc: (url?: string | null) => url ?? undefined,
  followUser: state.follow,
  unfollowUser: state.unfollow,
  removeFollower: state.removeFollower,
  unblockUser: state.unblock,
}));

const user = { id: 'owner', username: 'owner', displayName: '我' } as AuthUser;

beforeEach(() => {
  for (const mock of Object.values(state)) mock.mockReset();
  state.contacts.mockResolvedValue({
    users: [
      {
        id: 'friend',
        username: 'friend',
        displayName: '好友',
        followedAt: 1,
        mutual: true,
      },
    ],
    nextOffset: null,
  });
  state.discover.mockResolvedValue({ users: [], nextOffset: null });
  state.following.mockResolvedValue({ users: [], nextOffset: null });
  state.followers.mockResolvedValue({ users: [], nextOffset: null });
  state.blocks.mockResolvedValue([]);
  state.lookup.mockResolvedValue(null);
  for (const action of [state.follow, state.unfollow, state.removeFollower, state.unblock])
    action.mockResolvedValue({ ok: true });
  window.history.replaceState(null, '', '/people');
});

afterEach(cleanup);

it.each([
  { presentation: 'page', closes: false },
  { presentation: 'dialog', closes: true },
] as const)(
  'opens the friends list first and requests a mutual direct message from a $presentation (closes: $closes)',
  async ({ presentation, closes }) => {
    const onClose = vi.fn();
    render(<ContactsDialog user={user} presentation={presentation} onClose={onClose} />);
    expect(screen.getByRole('tab', { name: '好友' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(await screen.findByRole('button', { name: '私聊' }));
    expect(state.dm).toHaveBeenCalledWith('friend', {
      username: 'friend',
      displayName: '好友',
    });
    if (closes) expect(onClose).toHaveBeenCalledOnce();
    else expect(onClose).not.toHaveBeenCalled();
  },
);

it('switches discovery without showing a stale username lookup after editing the query', async () => {
  render(<ContactsDialog user={user} presentation="page" onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '添加朋友' }));
  expect(await screen.findByText('暂无可发现的用户')).toBeTruthy();
  const search = screen.getByRole('searchbox', { name: '搜索用户名' });
  fireEvent.change(search, { target: { value: 'hidden' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '查找' }));
  });
  expect(screen.getByText('未找到用户')).toBeTruthy();
  fireEvent.change(search, { target: { value: 'another' } });
  expect(screen.queryByText('未找到用户')).toBeNull();
});

it('starts discovery at the first page and cycles through available pages', async () => {
  const first = {
    id: 'first',
    username: 'first',
    displayName: '第一位',
    following: false,
    followedBy: false,
  };
  const second = {
    id: 'second',
    username: 'second',
    displayName: '第二位',
    following: false,
    followedBy: false,
  };
  state.discover
    .mockResolvedValueOnce({ users: [first], nextOffset: 20 })
    .mockResolvedValueOnce({ users: [second], nextOffset: null })
    .mockResolvedValueOnce({ users: [first], nextOffset: 20 });
  render(<ContactsDialog user={user} presentation="page" onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '添加朋友' }));
  expect(await screen.findByText('第一位')).toBeTruthy();
  expect(state.discover).toHaveBeenNthCalledWith(1, { limit: 20, offset: 0 });

  fireEvent.click(screen.getByRole('button', { name: '换一批' }));
  expect(await screen.findByText('第二位')).toBeTruthy();
  expect(state.discover).toHaveBeenNthCalledWith(2, { limit: 20, offset: 20 });

  fireEvent.click(screen.getByRole('button', { name: '换一批' }));
  expect(await screen.findByText('第一位')).toBeTruthy();
  expect(state.discover).toHaveBeenNthCalledWith(3, { limit: 20, offset: 0 });
});

it('loads later contact pages without losing the first page', async () => {
  state.contacts
    .mockResolvedValueOnce({
      users: [
        { id: 'first', username: 'first', displayName: '第一位', followedAt: 2, mutual: true },
      ],
      nextOffset: 20,
    })
    .mockResolvedValueOnce({
      users: [
        { id: 'second', username: 'second', displayName: '第二位', followedAt: 1, mutual: true },
      ],
      nextOffset: null,
    });
  render(<ContactsDialog user={user} presentation="page" onClose={vi.fn()} />);
  expect(await screen.findByText('第一位')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
  expect(await screen.findByText('第二位')).toBeTruthy();
  expect(screen.getByText('第一位')).toBeTruthy();
  expect(state.contacts).toHaveBeenLastCalledWith({ limit: 20, offset: 20 });
  expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull();
});

it('hides old contacts immediately when the signed-in account changes', async () => {
  const next = { id: 'other', username: 'other', displayName: '另一账号' } as AuthUser;
  const view = render(<ContactsDialog user={user} presentation="page" onClose={vi.fn()} />);
  expect(await screen.findByText('@friend')).toBeTruthy();
  state.contacts.mockResolvedValueOnce({ users: [], nextOffset: null });
  view.rerender(<ContactsDialog user={next} presentation="page" onClose={vi.fn()} />);
  expect(screen.queryByText('@friend')).toBeNull();
  expect(await screen.findByText('暂无好友，互相关注后会显示在这里')).toBeTruthy();
});

it('subscribes to the width breakpoint once rather than on every render', async () => {
  const original = window.matchMedia;
  let subscribes = 0;
  let unsubscribes = 0;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) =>
      ({
        matches: true,
        media: query,
        addEventListener: () => {
          subscribes++;
        },
        removeEventListener: () => {
          unsubscribes++;
        },
      }) as unknown as MediaQueryList,
  });
  try {
    const view = render(<ContactsDialog user={user} presentation="page" onClose={vi.fn()} />);
    expect(await screen.findByText('@friend')).toBeTruthy();
    const settled = subscribes;
    for (let i = 0; i < 3; i++)
      view.rerender(<ContactsDialog user={user} presentation="page" onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索联系人' }), {
      target: { value: '好' },
    });
    expect(subscribes).toBe(settled);
    expect(unsubscribes).toBe(0);
  } finally {
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: original });
  }
});

it('keeps only 好友 / 关注 / 粉丝 as tabs and opens discovery and the block list as pushed screens', async () => {
  render(<ContactsDialog user={user} presentation="page" onClose={vi.fn()} />);
  expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
    '好友',
    '关注',
    '粉丝',
  ]);
  fireEvent.click(screen.getByRole('button', { name: '添加朋友' }));
  expect(window.location.search).toBe('?view=discover');
  expect(screen.getByRole('heading', { name: '添加朋友' })).toBeTruthy();
  expect(screen.queryByRole('tablist')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '返回联系人' }));
  // jsdom delivers the popstate for history.back() asynchronously.
  await waitFor(() => expect(window.location.search).toBe(''));
  expect(await screen.findByRole('tablist', { name: '联系人分类' })).toBeTruthy();

  state.blocks.mockResolvedValue([
    { id: 'blocked', username: 'blocked', displayName: '已屏蔽', blockedAt: 1 },
  ]);
  fireEvent.click(screen.getByRole('button', { name: '黑名单' }));
  fireEvent.click(await screen.findByRole('button', { name: '解除屏蔽' }));
  await act(async () => {});
  expect(state.unblock).toHaveBeenCalledWith('blocked');
});

it('opens the block list from a deep link', async () => {
  window.history.replaceState(null, '', '/people?view=blocked');
  render(<ContactsDialog user={user} presentation="page" onClose={vi.fn()} />);
  expect(screen.getByRole('heading', { name: '黑名单' })).toBeTruthy();
  expect(await screen.findByText('黑名单为空')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '返回联系人' }));
  expect(window.location.pathname + window.location.search).toBe('/people');
  expect(await screen.findByRole('tab', { name: '好友' })).toBeTruthy();
});

it('opens the profile from the whole row and keeps one trailing action per relationship', async () => {
  state.following.mockResolvedValue({
    users: [
      { id: 'one-way', username: 'oneway', displayName: '单向', followedAt: 1, mutual: false },
    ],
    nextOffset: null,
  });
  state.followers.mockResolvedValue({
    users: [{ id: 'fan', username: 'fan', displayName: '粉丝甲', followedAt: 1, mutual: false }],
    nextOffset: null,
  });
  render(<ContactsDialog user={user} presentation="page" onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: /好友.*@friend/ }));
  expect(state.profile).toHaveBeenCalledWith('friend');
  // 取消关注 lives on the profile page, never on a row.
  expect(screen.queryByRole('button', { name: '取消关注' })).toBeNull();

  fireEvent.click(screen.getByRole('tab', { name: '关注' }));
  expect(await screen.findByText('单向')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '私聊' })).toBeNull();
  expect(screen.queryByRole('button', { name: '取消关注' })).toBeNull();

  fireEvent.click(screen.getByRole('tab', { name: '粉丝' }));
  fireEvent.click(await screen.findByRole('button', { name: '回关' }));
  await act(async () => {});
  expect(state.follow).toHaveBeenCalledWith('fan');
  fireEvent.click(await screen.findByRole('button', { name: '移除粉丝' }));
  await act(async () => {});
  expect(state.removeFollower).toHaveBeenCalledWith('fan');
});
