// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CreatorFollowAction } from './CreatorFollowAction';
const api = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('../api', () => ({ fetchCreatorFollow: api.read, saveCreatorFollow: api.write }));
vi.mock('@0xnullai/auth', () => ({ subscribeAuthChanges: () => () => {} }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it('shows verified publisher identity and follows that ID rather than a typed nickname', async () => {
  api.read.mockResolvedValue({
    creator: { id: 'creator', username: 'real', displayName: '真实' },
    accountId: 'viewer',
    followed: false,
  });
  api.write.mockResolvedValue(undefined);
  render(createElement(CreatorFollowAction, { itemId: 'card' }));
  fireEvent.click(await screen.findByRole('button', { name: '关注作者' }));
  await screen.findByRole('button', { name: '已关注 · 取消' });
  expect(api.write).toHaveBeenCalledWith('card', 'creator', true, 'viewer');
  fireEvent.click(screen.getByRole('button', { name: '已关注 · 取消' }));
  await waitFor(() =>
    expect(api.write).toHaveBeenLastCalledWith('card', 'creator', false, 'viewer'),
  );
});
it('does not invent an account for a legacy card', async () => {
  api.read.mockResolvedValue({ creator: null, accountId: 'viewer', followed: false });
  render(createElement(CreatorFollowAction, { itemId: 'legacy' }));
  await screen.findByText(/暂无可验证/);
  expect(screen.queryByRole('button')).toBeNull();
});
