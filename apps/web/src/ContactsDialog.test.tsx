import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  followUser: vi.fn(),
  unfollowUser: vi.fn(),
  removeFollower: vi.fn(),
  unblockUser: vi.fn(),
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
  fireEvent.click(screen.getByRole('tab', { name: '发现' }));
  expect(await screen.findByText('暂无可发现的用户')).toBeTruthy();
  const search = screen.getByRole('textbox', { name: '搜索用户名或联系人' });
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
  fireEvent.click(screen.getByRole('tab', { name: '发现' }));
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
