// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { CreatorFollowAction } from './CreatorFollowAction';

const mocked = vi.hoisted(() => ({ profile: vi.fn(), follow: vi.fn() }));
vi.mock('@0xnullai/auth', () => ({
  requestProfileView: mocked.profile,
  subscribeAuthChanges: () => () => undefined,
}));
vi.mock('../api', () => ({
  fetchCreatorFollow: async () => ({
    creator: { id: 'creator-1', username: 'verified', displayName: '认证作者' },
    followed: false,
    accountId: 'viewer',
  }),
  saveCreatorFollow: mocked.follow,
}));

it('opens the verified publishing account rather than an editable work signature', async () => {
  render(<CreatorFollowAction itemId="card-1" />);
  fireEvent.click(await screen.findByRole('button', { name: '发布账户：认证作者 (@verified)' }));
  expect(mocked.profile).toHaveBeenCalledWith('verified');
  expect(mocked.follow).not.toHaveBeenCalled();
});
