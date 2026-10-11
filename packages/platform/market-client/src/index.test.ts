import { afterEach, expect, it, vi } from 'vitest';
import { fetchCreatorMarketItems, fetchMarketItem, fetchMarketItems } from './index.js';

vi.mock('@0xnullai/settings', () => ({ apiBaseUrl: () => '' }));
const auth = vi.hoisted(() => ({ account: 'viewer' }));
vi.mock('@0xnullai/auth', () => ({
  currentAuthUserId: () => auth.account,
  authRequestHeaders: () => ({ Authorization: 'Bearer test' }),
}));
afterEach(() => vi.unstubAllGlobals());

it('loads verified public creator works only for the current account', async () => {
  auth.account = 'viewer';
  const fetch = vi.fn(async () =>
    Response.json({
      accountId: 'viewer',
      items: [
        { id: 'card', type: 'scenario' },
        { id: 'retired', type: 'multi-scene' },
      ],
    }),
  );
  vi.stubGlobal('fetch', fetch);
  await expect(fetchCreatorMarketItems('author', 'viewer')).resolves.toEqual([
    { id: 'card', type: 'scenario' },
  ]);
  expect(fetch).toHaveBeenCalledWith('/api/items/discovery?mode=creator&creatorId=author', {
    credentials: 'same-origin',
    cache: 'no-store',
    signal: undefined,
    headers: { Authorization: 'Bearer test', 'X-Account-Id': 'viewer' },
  });
  await expect(fetchCreatorMarketItems('../author', 'viewer')).rejects.toThrow('编号无效');
  auth.account = 'other';
  await expect(fetchCreatorMarketItems('author', 'viewer')).rejects.toThrow('账号已切换');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('drops a creator response if the account changes while it is in flight', async () => {
  auth.account = 'viewer';
  let finish!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  const pending = fetchCreatorMarketItems('author', 'viewer');
  auth.account = 'other';
  finish(Response.json({ accountId: 'viewer', items: [{ id: 'card', type: 'scenario' }] }));
  await expect(pending).rejects.toThrow('账号已切换');
});

it('fetches only the exact public item requested for an opt-in persona update', async () => {
  const fetch = vi.fn(async () =>
    Response.json({ item: { id: 'card-1', type: 'scenario', revision: 3 } }),
  );
  vi.stubGlobal('fetch', fetch);
  await expect(fetchMarketItem('card-1')).resolves.toMatchObject({
    id: 'card-1',
    revision: 3,
  });
  expect(fetch).toHaveBeenCalledWith('/api/items/card-1', { cache: 'no-store' });
  await expect(fetchMarketItem('../other')).rejects.toThrow('编号无效');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('rejects a mismatched or unavailable public item without offering it for adoption', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ item: { id: 'other' } })),
  );
  await expect(fetchMarketItem('card-1')).rejects.toThrow('条目不匹配');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 404 })),
  );
  await expect(fetchMarketItem('card-1')).rejects.toThrow('无法读取 (404)');
});

it('does not surface retired multiplayer scenes from an older Market server', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        items: [
          { id: 'retired', type: 'multi-scene' },
          { id: 'scene', type: 'scenario' },
        ],
        item: { id: 'retired', type: 'multi-scene' },
      }),
    ),
  );
  await expect(fetchMarketItems({ type: 'scenario' })).resolves.toEqual([
    { id: 'scene', type: 'scenario' },
  ]);
  await expect(fetchMarketItem('retired')).rejects.toThrow('类型已下线');
});

it('resolves only public UUID portraits and reads anonymously with missing-image fallback', async () => {
  const { marketPortraitUrl, fetchPublicMarketPortrait } = await import('./index.js');
  expect(marketPortraitUrl('https://tracker.test/a')).toBeNull();
  const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const fetch = vi.fn(
    async () =>
      new Response(new Blob(['png'], { type: 'image/png' }), {
        headers: { 'Content-Type': 'image/png' },
      }),
  );
  vi.stubGlobal('fetch', fetch);
  expect((await fetchPublicMarketPortrait(id))?.type).toBe('image/png');
  expect(fetch).toHaveBeenCalledWith(`/api/items/character-portraits/${id}/content`, {
    credentials: 'omit',
    cache: 'no-store',
    signal: undefined,
  });
  fetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
  expect(await fetchPublicMarketPortrait(id)).toBeNull();
  fetch.mockResolvedValueOnce(
    new Response('<html/>', { headers: { 'Content-Type': 'text/html' } }),
  );
  expect(await fetchPublicMarketPortrait(id)).toBeNull();
});
