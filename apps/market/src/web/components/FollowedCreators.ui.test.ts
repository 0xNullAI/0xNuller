// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FollowedCreators } from './FollowedCreators';
const mocked = vi.hoisted(() => ({
  write: vi.fn(async () => {}),
  fetch: vi.fn(),
  profile: vi.fn(),
  authChanged: null as null | (() => void),
}));
vi.mock('../api', () => ({
  fetchFollowedCreators: mocked.fetch,
  saveCreatorFollow: mocked.write,
}));
vi.mock('@0xnullai/auth', () => ({
  subscribeAuthChanges: (callback: () => void) => {
    mocked.authChanged = callback;
    return () => {
      mocked.authChanged = null;
    };
  },
  requestProfileView: mocked.profile,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocked.authChanged = null;
});
it('lets users remove a followed account even when its public content disappeared', async () => {
  mocked.fetch.mockResolvedValue({
    accountId: 'user',
    creators: [{ id: 'removed-user', profile: null }],
  });
  const changed = vi.fn();
  render(createElement(FollowedCreators, { onChanged: changed }));
  fireEvent.click(screen.getByText(/管理已关注作者/));
  fireEvent.click(await screen.findByRole('button', { name: '取消关注' }));
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(mocked.write).toHaveBeenCalledWith('', 'removed-user', false, 'user');
  expect(screen.queryByRole('button', { name: '取消关注' })).toBeNull();
});

it('reloads the new account and ignores a late list from the previous account', async () => {
  let resolveOld!: (value: unknown) => void;
  mocked.fetch
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValueOnce({
      accountId: 'new-user',
      creators: [
        {
          id: 'verified-author',
          profile: { displayName: '新作者', username: 'new-author' },
        },
      ],
    });
  render(createElement(FollowedCreators, { onChanged: () => {} }));
  fireEvent.click(screen.getByText(/管理已关注作者/));
  await act(async () => mocked.authChanged?.());
  fireEvent.click(await screen.findByRole('button', { name: '新作者 (@new-author)' }));
  expect(mocked.profile).toHaveBeenCalledWith('new-author');
  await act(async () =>
    resolveOld({
      accountId: 'old-user',
      creators: [{ id: 'old-author', profile: null }],
    }),
  );
  expect(screen.getByRole('button', { name: '新作者 (@new-author)' })).toBeTruthy();
  expect(screen.queryByText(/old-author/)).toBeNull();
});
