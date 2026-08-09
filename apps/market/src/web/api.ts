import type { ItemPatch, BatchUploadPayload, ItemType, MarketItem, UploadPayload } from '../shared/schema';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error((data.error as string) || `请求失败 (${res.status})`);
  return data as T;
}


export interface ListQuery {
  type?: ItemType;
  q?: string;
  sort?: 'new' | 'popular';
  limit?: number;
  offset?: number;
}

export async function fetchItems(query: ListQuery): Promise<MarketItem[]> {
  const params = new URLSearchParams();
  if (query.type) params.set('type', query.type);
  if (query.q) params.set('q', query.q);
  if (query.sort) params.set('sort', query.sort);
  if (query.limit) params.set('limit', String(query.limit));
  if (query.offset) params.set('offset', String(query.offset));
  // req() returns an empty object when the response is "HTTP 200 but not the JSON we
  // expect" (for example when some frontend route fell back to index.html), so the
  // destructured items is undefined and the downstream items.length throws, whiting out
  // the whole page. Fall back to an empty array here — if the list can't be fetched we
  // show 「还没有内容」 instead of crashing.
  const { items } = await req<{ items?: MarketItem[] }>(`/api/items?${params}`);
  return items ?? [];
}

export async function fetchItem(id: string): Promise<MarketItem> {
  const { item } = await req<{ item: MarketItem }>(`/api/items/${id}`);
  return item;
}

export async function uploadItem(payload: UploadPayload): Promise<{ id: string }> {
  return req('/api/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

// Batch upload: submit several items at once, returns how many succeeded.
export async function batchUploadItems(items: BatchUploadPayload): Promise<{ inserted: number }> {
  return req('/api/items/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(items),
  });
}

export async function markDownloaded(id: string): Promise<void> {
  await fetch(`/api/items/${id}/download`, { method: 'POST' }).catch(() => {});
}

export async function markViewed(id: string): Promise<void> {
  await fetch(`/api/items/${id}/view`, { method: 'POST' }).catch(() => {});
}

export async function reportItem(id: string): Promise<void> {
  await req(`/api/items/${id}/report`, { method: 'POST' });
}

// Change item metadata. Items with no key set need no key; items with a key take the one
// set at upload time.
// The same value is sent as both X-Edit-Key and X-Admin-Key: ordinary users go through the
// item's key, while an admin who types ADMIN_KEY can override and edit any item.
export async function updateItem(id: string, patch: ItemPatch, key?: string): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) {
    headers['X-Edit-Key'] = key;
    headers['X-Admin-Key'] = key;
  }
  await req(`/api/items/${id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(patch),
  });
}
