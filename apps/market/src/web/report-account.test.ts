// @vitest-environment jsdom
import type * as SettingsModule from '@0xnullai/settings';
import { afterEach, expect, it, vi } from 'vitest';
import {
  fetchCharacterReports,
  reportCharacter,
  saveDiscoveryFeedback,
  recordCharacterStart,
} from './api';
const state = vi.hoisted(() => ({
  account: 'a' as string | null,
  listeners: new Set<() => void>(),
}));
vi.mock('@0xnullai/auth', () => ({
  currentAuthUserId: () => state.account,
  subscribeAuthChanges: (listener: () => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  },
}));
vi.mock('@0xnullai/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof SettingsModule>()),
  apiBaseUrl: () => '',
}));
afterEach(() => {
  vi.unstubAllGlobals();
  state.account = 'a';
});
it('sends the exact owner and bounded reason, and does not request without login', async () => {
  const fetch = vi.fn(async () => Response.json({ ok: true }));
  vi.stubGlobal('fetch', fetch);
  await reportCharacter('card', 'privacy');
  expect(fetch).toHaveBeenCalledWith(
    '/api/items/card/report',
    expect.objectContaining({
      method: 'PUT',
      cache: 'no-store',
      body: '{"reason":"privacy"}',
      headers: expect.objectContaining({ 'X-Account-Id': 'a' }),
    }),
  );
  state.account = null;
  await expect(reportCharacter('card', 'privacy')).rejects.toThrow('请先登录');
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('permanently discards an in-flight report response after A to B to A switching', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      state.account = 'b';
      state.listeners.forEach((listener) => listener());
      state.account = 'a';
      state.listeners.forEach((listener) => listener());
      return Response.json({ items: [], nextOffset: null });
    }),
  );
  await expect(fetchCharacterReports()).rejects.toThrow('账户已切换');
  expect(state.listeners.size).toBe(0);
});
it('sends only a chosen discovery reason and public-card start event for the current account', async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({ accountId: 'a', recorded: true }),
  );
  vi.stubGlobal('fetch', fetch);
  await saveDiscoveryFeedback('card', 'hide_creator', 'verified-owner');
  await recordCharacterStart('card');
  expect(fetch.mock.calls[0]?.[0]).toBe('/api/items/card/discovery-feedback');
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({
    method: 'PUT',
    body: '{"reason":"hide_creator","creatorId":"verified-owner"}',
  });
  expect(fetch.mock.calls[1]?.[0]).toBe('/api/items/card/character-start');
  expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: 'POST' });
  expect(fetch.mock.calls[1]?.[1]).not.toHaveProperty('body');
});
