import type { ItemType, MarketItem, UploadPayload } from '../shared/schema';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error((data.error as string) || `请求失败 (${res.status})`);
  return data as T;
}

export async function fetchConfig(): Promise<{ turnstileSiteKey: string }> {
  return req('/api/config');
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
  const { items } = await req<{ items: MarketItem[] }>(`/api/items?${params}`);
  return items;
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

export async function markDownloaded(id: string): Promise<void> {
  await fetch(`/api/items/${id}/download`, { method: 'POST' }).catch(() => {});
}

export async function reportItem(id: string): Promise<void> {
  await req(`/api/items/${id}/report`, { method: 'POST' });
}
