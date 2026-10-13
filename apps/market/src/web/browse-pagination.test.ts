// @vitest-environment jsdom
import type * as SettingsModule from '@0xnullai/settings';
import { afterEach, expect, it, vi } from 'vitest';
import { fetchBrowsePage, fetchItems } from './api';
import { appendBrowsePage } from './browse-pages';
import type { MarketItem } from '../shared/schema';

vi.mock('@0xnullai/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof SettingsModule>()),
  apiBaseUrl: () => '',
}));

afterEach(() => vi.unstubAllGlobals());

it('requests the selected category and next public page', async () => {
  const fetch = vi.fn(async (_url: RequestInfo | URL) => Response.json({ items: [] }));
  vi.stubGlobal('fetch', fetch);
  await fetchItems({ type: 'scenario', kind: 'character', sort: 'new', limit: 50, offset: 50 });
  const url = new URL(fetch.mock.calls[0]![0] as string, 'https://market.test');
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    type: 'scenario',
    kind: 'character',
    sort: 'new',
    limit: '50',
    offset: '50',
  });
});

it('shows invalid browse responses as errors instead of an empty market', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('<html>wrong route</html>', { status: 200 })),
  );
  await expect(fetchItems({ type: 'waveform', limit: 50 })).rejects.toThrow('市场内容响应无效');
});

it('round-trips the server cursor and rejects a response missing pagination metadata', async () => {
  const fetch = vi.fn(async (_url: RequestInfo | URL) =>
    Response.json({ items: [], nextCursor: null, pagination: 'stable' }),
  );
  vi.stubGlobal('fetch', fetch);
  await fetchBrowsePage({
    type: 'scenario',
    kind: 'scene',
    q: '月光',
    limit: 50,
    cursor: 'signed.cursor',
  });
  const url = new URL(fetch.mock.calls[0]![0] as string, 'https://market.test');
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    pagination: 'cursor',
    type: 'scenario',
    kind: 'scene',
    q: '月光',
    limit: '50',
    cursor: 'signed.cursor',
  });
  fetch.mockImplementationOnce(async () => Response.json({ items: [] }));
  await expect(fetchBrowsePage({ type: 'scenario' })).rejects.toThrow('市场分页响应无效');
});

it('keeps a repeated public card from appearing twice after a live page moves', () => {
  const item = (id: string) => ({ id }) as MarketItem;
  const first = Array.from({ length: 50 }, (_, index) => item(`item-${index}`));
  const second = [item('item-49'), item('item-50')];
  expect(appendBrowsePage(first, second)).toHaveLength(51);
});
