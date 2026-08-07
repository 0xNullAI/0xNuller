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
  // req() 在「HTTP 200 但响应不是预期 JSON」时会返回空对象（例如被某个前端路由
  // 兜底成了 index.html），解构出的 items 就是 undefined，下游 items.length 直接
  // 抛错整页白屏。这里兜底成空数组——列表拿不到就显示「还没有内容」，而不是崩掉。
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

// 批量上传：一次提交多条，返回成功条数。
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

// 改条目元数据。未设口令的条目无需 key；设了口令则传上传时的口令。
// 同一值同时作 X-Edit-Key 与 X-Admin-Key 发送：普通用户走条目口令，
// 管理员输入 ADMIN_KEY 即可覆盖编辑任何条目。
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
