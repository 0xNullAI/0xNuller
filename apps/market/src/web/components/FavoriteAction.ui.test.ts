// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FavoriteAction } from './FavoriteAction';
const api = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock('../api', () => ({
  fetchFavorite: async () => ({ favorited: false, accountId: 'user' }),
  saveFavorite: api.save,
}));
vi.mock('@0xnullai/auth', () => ({ subscribeAuthChanges: () => () => {} }));
afterEach(cleanup);
it('adds and removes a server favorite with the account that loaded it', async () => {
  api.save
    .mockResolvedValueOnce({ favorited: true, accountId: 'user' })
    .mockResolvedValueOnce({ favorited: false, accountId: 'user' });
  render(createElement(FavoriteAction, { itemId: 'card' }));
  const add = await screen.findByRole('button', { name: '收藏角色 / 内容' });
  await vi.waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(add);
  fireEvent.click(await screen.findByRole('button', { name: '已收藏 · 取消' }));
  await vi.waitFor(() => expect(api.save).toHaveBeenLastCalledWith('card', false, 'user'));
});
