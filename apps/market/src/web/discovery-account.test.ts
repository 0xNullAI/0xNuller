// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { fetchDiscovery } from './api';
const state = vi.hoisted(() => ({ account: 'a' }));
vi.mock('@0xnullai/auth', () => ({ currentAuthUserId: () => state.account }));
vi.mock('@0xnullai/settings', () => ({ apiBaseUrl: () => '' }));
afterEach(() => {
  vi.unstubAllGlobals();
  state.account = 'a';
});
it('drops private discovery results when the account changes during the request', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      state.account = 'b';
      return Response.json({ accountId: 'a', items: [{ id: 'private-save' }] });
    }),
  );
  await expect(fetchDiscovery('favorites')).rejects.toThrow('账户已变化');
});
it('rejects a stale favorite write before it reaches the server', async () => {
  const { saveFavorite } = await import('./api');
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(saveFavorite('card', true, 'previous')).rejects.toThrow('账户已变化');
  expect(fetch).not.toHaveBeenCalled();
});
