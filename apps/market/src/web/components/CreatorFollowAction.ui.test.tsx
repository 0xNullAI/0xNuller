// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CreatorFollowAction } from './CreatorFollowAction';

const mocked = vi.hoisted(() => ({ profile: vi.fn(), read: vi.fn(), follow: vi.fn() }));
vi.mock('@0xnullai/auth', () => ({
  requestProfileView: mocked.profile,
  subscribeAuthChanges: () => () => undefined,
}));
vi.mock('../api', () => ({
  fetchCreatorFollow: mocked.read,
  saveCreatorFollow: mocked.follow,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('opens the verified publishing account rather than an editable work signature', async () => {
  mocked.read.mockResolvedValue({
    creator: { id: 'creator-1', username: 'verified', displayName: '认证作者' },
    followed: false,
    accountId: 'viewer',
  });
  render(<CreatorFollowAction itemId="card-1" />);
  fireEvent.click(await screen.findByRole('button', { name: '发布账户：认证作者 (@verified)' }));
  expect(mocked.profile).toHaveBeenCalledWith('verified');
  expect(mocked.follow).not.toHaveBeenCalled();
});

it('shows verified publisher identity and follows that ID rather than a typed nickname', async () => {
  mocked.read.mockResolvedValue({
    creator: { id: 'creator', username: 'real', displayName: '真实' },
    accountId: 'viewer',
    followed: false,
  });
  mocked.follow.mockResolvedValue(undefined);
  render(<CreatorFollowAction itemId="card" />);
  fireEvent.click(await screen.findByRole('button', { name: '关注作者' }));
  await screen.findByRole('button', { name: '已关注 · 取消' });
  expect(mocked.follow).toHaveBeenCalledWith('card', 'creator', true, 'viewer');
  fireEvent.click(screen.getByRole('button', { name: '已关注 · 取消' }));
  await waitFor(() =>
    expect(mocked.follow).toHaveBeenLastCalledWith('card', 'creator', false, 'viewer'),
  );
});

it('does not invent an account for a legacy card', async () => {
  mocked.read.mockResolvedValue({ creator: null, accountId: 'viewer', followed: false });
  render(<CreatorFollowAction itemId="legacy" />);
  await screen.findByText(/暂无可验证/);
  expect(screen.queryByRole('button')).toBeNull();
});
