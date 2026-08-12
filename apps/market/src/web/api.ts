import { apiBaseUrl } from '@0xnullai/settings';
import type {
  ItemPatch,
  BatchUploadPayload,
  MarketAdminItem,
  ItemType,
  MarketItem,
  UploadPayload,
} from '../shared/schema';

const TOKEN_KEY = '0xnullai.auth-token';

function accountHeaders(): Record<string, string> {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  // Every path here is relative. On the web that is what we want, but the
  // Tauri WebView's origin is a local scheme, so a bare relative fetch hits
  // the WebView's own asset server and comes back as index.html — which
  // then fails as "Unexpected token '<'", nowhere near the real cause.
  const res = await fetch(`${apiBaseUrl()}${path}`, {
    ...init,
    // Same-origin web requests carry the HttpOnly account cookie. Tauri is cross-origin
    // and uses the Bearer token above; avoiding `include` keeps wildcard Market CORS valid.
    credentials: 'same-origin',
    headers: { ...accountHeaders(), ...init?.headers },
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error((data.error as string) || `请求失败 (${res.status})`);
  return data as T;
}

export interface ListQuery {
  type?: ItemType;
  modality?: 'electrostimulation' | 'vibration';
  q?: string;
  sort?: 'new' | 'popular';
  limit?: number;
  offset?: number;
}

export async function fetchItems(query: ListQuery): Promise<MarketItem[]> {
  const params = new URLSearchParams();
  if (query.type) params.set('type', query.type);
  if (query.modality) params.set('modality', query.modality);
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
  await fetch(`${apiBaseUrl()}/api/items/${id}/download`, { method: 'POST' }).catch(() => {});
}

export async function markViewed(id: string): Promise<void> {
  await fetch(`${apiBaseUrl()}/api/items/${id}/view`, { method: 'POST' }).catch(() => {});
}

export async function fetchItemAccess(
  id: string,
): Promise<{ canEdit: boolean; canDelete: boolean }> {
  return req(`/api/items/${id}/access`);
}

export async function updateItem(id: string, patch: ItemPatch): Promise<void> {
  await req(`/api/items/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export async function deleteItem(id: string): Promise<void> {
  await req(`/api/items/${id}`, { method: 'DELETE' });
}

export type AdminItemStatus = 'all' | 'hidden';

export async function fetchAdminItems(input: {
  status: AdminItemStatus;
  q?: string;
  offset?: number;
  limit?: number;
}): Promise<{ items: MarketAdminItem[]; nextOffset: number | null }> {
  const params = new URLSearchParams({ status: input.status });
  if (input.q) params.set('q', input.q);
  if (input.offset) params.set('offset', String(input.offset));
  if (input.limit) params.set('limit', String(input.limit));
  return req(`/api/items/admin?${params}`);
}

export async function setItemHidden(id: string, hidden: boolean): Promise<void> {
  await req(`/api/items/${id}/moderation`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hidden }),
  });
}
