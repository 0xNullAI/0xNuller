import { currentAuthUserId, subscribeAuthChanges } from '@0xnullai/auth';
import { apiBaseUrl, AUTH_TOKEN_SECRET, readSecret } from '@0xnullai/settings';
import type {
  CharacterDraft,
  CharacterRevisionSnapshot,
  CharacterRevisionSummary,
  ItemPatch,
  BatchUploadPayload,
  MarketAdminItem,
  ItemType,
  PromptKind,
  MarketItem,
  UploadPayload,
} from '../shared/schema';

function accountHeaders(): Record<string, string> {
  const token = readSecret(AUTH_TOKEN_SECRET);
  return token ? { Authorization: `Bearer ${token}` } : {};
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
  if (!res.ok) {
    // Keep protocol details in the network layer. People who cannot manage an item only
    // need the actionable result; exposing a raw 403 in the interface adds no value.
    if (res.status === 403) throw new Error('无权限');
    throw new Error((data.error as string) || `请求失败 (${res.status})`);
  }
  return data as T;
}

export function characterPortraitUrl(id: string): string {
  return `${apiBaseUrl()}/api/items/character-portraits/${encodeURIComponent(id)}/content`;
}

export async function uploadCharacterPortrait(file: File): Promise<string> {
  const response = await fetch(`${apiBaseUrl()}/api/items/character-portraits`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { ...accountHeaders(), 'Content-Type': file.type },
    body: file,
  });
  const data = (await response.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!response.ok || !data.id) throw new Error(data.error ?? '头像上传失败');
  return data.id;
}

export async function deleteCharacterPortrait(id: string): Promise<void> {
  await req(`/api/items/character-portraits/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function fetchCharacterPortrait(id: string): Promise<Blob> {
  const response = await fetch(characterPortraitUrl(id), {
    credentials: 'same-origin',
    headers: accountHeaders(),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('头像预览暂不可用');
  return response.blob();
}

export interface PrivateCharacterContainer {
  id: string;
  type: 'png' | 'charx';
  bytes: number;
  createdAt: number;
}

const CONTAINERS = '/api/items/character-container-drafts';

export async function uploadCharacterContainer(file: File, account: string): Promise<string> {
  const mime = /\.charx$/i.test(file.name) ? 'application/zip' : 'image/png';
  const response = await fetch(`${apiBaseUrl()}${CONTAINERS}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { ...accountHeaders(), 'X-Account-Id': account, 'Content-Type': mime },
    body: file,
  });
  const data = (await response.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!response.ok || !data.id) throw new Error(data.error ?? '私有原文件上传失败');
  return data.id;
}

export async function fetchCharacterContainer(id: string, account: string): Promise<Blob> {
  const response = await fetch(`${apiBaseUrl()}${CONTAINERS}/${encodeURIComponent(id)}/content`, {
    credentials: 'same-origin',
    headers: { ...accountHeaders(), 'X-Account-Id': account },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('私有原文件读取失败');
  return response.blob();
}

export async function listCharacterContainers(
  account: string,
): Promise<PrivateCharacterContainer[]> {
  const data = await req<{ items: PrivateCharacterContainer[] }>(CONTAINERS, {
    headers: { 'X-Account-Id': account },
  });
  return data.items;
}

export async function deleteCharacterContainer(id: string, account: string): Promise<void> {
  await req(`${CONTAINERS}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'X-Account-Id': account },
  });
}

export interface ListQuery {
  character?: boolean;
  type?: ItemType;
  kind?: PromptKind;
  modality?: 'electrostimulation' | 'vibration';
  q?: string;
  sort?: 'trending' | 'new' | 'hot' | 'views' | 'downloads';
  limit?: number;
  offset?: number;
}

export async function fetchItems(query: ListQuery): Promise<MarketItem[]> {
  const params = new URLSearchParams();
  if (query.type) params.set('type', query.type);
  if (query.kind) params.set('kind', query.kind);
  if (query.character) params.set('character', '1');
  if (query.modality) params.set('modality', query.modality);
  if (query.q) params.set('q', query.q);
  if (query.sort) params.set('sort', query.sort);
  if (query.limit) params.set('limit', String(query.limit));
  if (query.offset) params.set('offset', String(query.offset));
  const result = await req<{ items?: MarketItem[] }>(`/api/items?${params}`);
  if (!Array.isArray(result.items)) throw new Error('市场内容响应无效，请稍后重试');
  return result.items;
}

export interface BrowsePage {
  items: MarketItem[];
  nextCursor: string | null;
  pagination: 'stable' | 'live';
}

/** Cursor API used by discovery; the older offset-based fetchItems remains compatible. */
export async function fetchBrowsePage(
  query: Omit<ListQuery, 'offset'> & { cursor?: string },
): Promise<BrowsePage> {
  const params = new URLSearchParams({ pagination: 'cursor' });
  if (query.type) params.set('type', query.type);
  if (query.kind) params.set('kind', query.kind);
  if (query.character) params.set('character', '1');
  if (query.modality) params.set('modality', query.modality);
  if (query.q) params.set('q', query.q);
  if (query.sort) params.set('sort', query.sort);
  if (query.limit) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const result = await req<Partial<BrowsePage>>(`/api/items?${params}`);
  if (
    !Array.isArray(result.items) ||
    !(result.nextCursor === null || typeof result.nextCursor === 'string') ||
    (result.pagination !== 'stable' && result.pagination !== 'live')
  )
    throw new Error('市场分页响应无效，请稍后重试');
  return result as BrowsePage;
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
  await fetch(`${apiBaseUrl()}/api/items/${id}/download`, {
    method: 'POST',
    headers: accountHeaders(),
  }).catch(() => {});
}

export async function tipItem(id: string, amount: number): Promise<void> {
  await req(`/api/items/${id}/tip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount }),
  });
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

export async function fetchCharacterVersions(id: string): Promise<CharacterRevisionSummary[]> {
  const account = currentAuthUserId();
  if (!account) throw new Error('请先登录后查看角色历史');
  const result = await req<{ versions: CharacterRevisionSummary[] }>(
    `/api/items/${encodeURIComponent(id)}/revisions`,
    { cache: 'no-store' },
  );
  if (currentAuthUserId() !== account) throw new Error('账号已变化，请重新打开角色编辑器');
  return result.versions;
}

export async function fetchCharacterVersion(
  id: string,
  revision: number,
): Promise<CharacterRevisionSnapshot> {
  const account = currentAuthUserId();
  if (!account) throw new Error('请先登录后查看角色历史');
  const result = await req<{ snapshot: CharacterRevisionSnapshot }>(
    `/api/items/${encodeURIComponent(id)}/revisions/${revision}`,
    { cache: 'no-store' },
  );
  if (currentAuthUserId() !== account) throw new Error('账号已变化，请重新打开角色编辑器');
  return result.snapshot;
}

function checkDraftAccount(accountId: string, responseAccountId: string): void {
  if (currentAuthUserId() !== accountId || responseAccountId !== accountId)
    throw new Error('账户已变化，请重新打开角色编辑器');
}

export async function fetchCharacterDraft(
  key: string,
  accountId: string,
): Promise<{ draft: CharacterDraft | null; revision: number }> {
  if (currentAuthUserId() !== accountId) throw new Error('账户已变化，请重新打开角色编辑器');
  const result = await req<{
    draft: CharacterDraft | null;
    revision?: number;
    accountId: string;
  }>(`/api/auth/character-drafts/${encodeURIComponent(key)}`, {
    cache: 'no-store',
    headers: { 'X-Account-Id': accountId },
  });
  checkDraftAccount(accountId, result.accountId);
  return { draft: result.draft, revision: result.revision ?? 0 };
}

export async function saveCharacterDraft(
  key: string,
  accountId: string,
  draft: CharacterDraft,
  expectedRevision: number,
): Promise<number> {
  if (currentAuthUserId() !== accountId) throw new Error('账户已变化，请重新打开角色编辑器');
  const result = await req<{ revision: number; accountId: string }>(
    `/api/auth/character-drafts/${encodeURIComponent(key)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Account-Id': accountId },
      body: JSON.stringify({ draft, expectedRevision }),
    },
  );
  checkDraftAccount(accountId, result.accountId);
  return result.revision;
}

export async function deleteCharacterDraft(
  key: string,
  accountId: string,
  revision: number,
): Promise<void> {
  if (currentAuthUserId() !== accountId) return;
  await req(`/api/auth/character-drafts/${encodeURIComponent(key)}?revision=${revision}`, {
    method: 'DELETE',
    headers: { 'X-Account-Id': accountId },
  });
}

export async function deleteItem(id: string): Promise<void> {
  await req(`/api/items/${id}`, { method: 'DELETE' });
}

export type AdminItemType = 'waveform' | 'scenario';
export type AdminItemStatus = 'all' | 'visible' | 'hidden';

export async function fetchAdminItems(input: {
  type: AdminItemType;
  status: AdminItemStatus;
  q?: string;
  offset?: number;
  limit?: number;
}): Promise<{ items: MarketAdminItem[]; nextOffset: number | null }> {
  const params = new URLSearchParams({ type: input.type, status: input.status });
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

export async function fetchItem(id: string): Promise<MarketItem> {
  const { item } = await req<{ item: MarketItem }>(`/api/items/${encodeURIComponent(id)}`);
  return item;
}

export interface FavoriteState {
  favorited: boolean;
  accountId: string;
}
export async function fetchFavorite(id: string): Promise<FavoriteState> {
  const account = currentAuthUserId();
  const result = await req<FavoriteState>(`/api/items/${encodeURIComponent(id)}/favorite`, {
    cache: 'no-store',
  });
  if (!account || account !== currentAuthUserId() || result.accountId !== account)
    throw new Error('账户已变化，请重新打开');
  return result;
}
export async function saveFavorite(
  id: string,
  enabled: boolean,
  accountId: string,
): Promise<FavoriteState> {
  if (currentAuthUserId() !== accountId) throw new Error('账户已变化，请重新打开');
  const result = await req<FavoriteState>(`/api/items/${encodeURIComponent(id)}/favorite`, {
    method: enabled ? 'PUT' : 'DELETE',
    headers: { 'X-Account-Id': accountId },
  });
  if (currentAuthUserId() !== accountId) throw new Error('账户已变化，请重新打开');
  return result;
}
export async function fetchDiscovery(
  mode: 'favorites' | 'recommended' | 'following',
  kind?: PromptKind,
  type?: 'scenario' | 'waveform',
): Promise<MarketItem[]> {
  const account = currentAuthUserId();
  const result = await req<{ items: MarketItem[]; accountId: string }>(
    `/api/items/discovery?mode=${mode}${kind ? `&kind=${kind}` : ''}${type ? `&type=${type}` : ''}`,
    {
      cache: 'no-store',
    },
  );
  if (!account || account !== currentAuthUserId() || result.accountId !== account)
    throw new Error('账户已变化，请刷新');
  return result.items;
}

export interface CreatorFollowState {
  creator: { id: string; username: string; displayName: string } | null;
  followed: boolean;
  accountId: string;
}
export async function fetchCreatorFollow(itemId: string): Promise<CreatorFollowState> {
  const account = currentAuthUserId();
  const result = await req<CreatorFollowState>(
    `/api/items/${encodeURIComponent(itemId)}/creator-follow`,
    { cache: 'no-store' },
  );
  if (!account || account !== currentAuthUserId() || result.accountId !== account)
    throw new Error('账户已变化，请重新打开');
  return result;
}
export async function saveCreatorFollow(
  itemId: string,
  creatorId: string,
  enabled: boolean,
  accountId: string,
): Promise<void> {
  if (currentAuthUserId() !== accountId) throw new Error('账户已变化，请重新打开');
  await req(
    enabled
      ? `/api/items/${encodeURIComponent(itemId)}/creator-follow?creatorId=${encodeURIComponent(creatorId)}`
      : `/api/items/creator-follows/${encodeURIComponent(creatorId)}`,
    { method: enabled ? 'PUT' : 'DELETE', headers: { 'X-Account-Id': accountId } },
  );
  if (currentAuthUserId() !== accountId) throw new Error('账户已变化，请重新打开');
}

export async function fetchFollowedCreators(): Promise<{
  accountId: string;
  creators: { id: string; profile: { displayName: string; username: string } | null }[];
}> {
  const account = currentAuthUserId();
  const result = await req<{
    accountId: string;
    creators: { id: string; profile: { displayName: string; username: string } | null }[];
  }>('/api/items/creator-follows', { cache: 'no-store' });
  if (!account || currentAuthUserId() !== account || result.accountId !== account)
    throw new Error('账户已变化，请重新打开');
  return result;
}

export type CharacterReportReason = 'unsafe' | 'harassment' | 'privacy' | 'copyright' | 'spam';
export interface CharacterReport {
  id: string;
  itemId: string;
  itemName: string;
  reason: CharacterReportReason;
  createdAt: number;
  hidden: number;
}
async function accountRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const account = currentAuthUserId();
  if (!account) throw new Error('请先登录');
  let changed = false;
  const stop = subscribeAuthChanges(() => {
    if (currentAuthUserId() !== account) changed = true;
  });
  try {
    const result = await req<T>(path, {
      ...init,
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Account-Id': account },
    });
    if (changed || currentAuthUserId() !== account) throw new Error('账户已切换，请刷新');
    return result;
  } finally {
    stop();
  }
}
export function reportCharacter(
  itemId: string,
  reason: CharacterReportReason,
): Promise<{ ok: boolean }> {
  return accountRequest(`/api/items/${encodeURIComponent(itemId)}/report`, {
    method: 'PUT',
    body: JSON.stringify({ reason }),
  });
}
export function fetchCharacterReports(
  offset = 0,
): Promise<{ items: CharacterReport[]; nextOffset: number | null }> {
  return accountRequest(`/api/items/admin/reports?offset=${offset}`);
}
export function resolveCharacterReport(
  id: string,
  action: 'hide' | 'dismiss',
): Promise<{ ok: boolean }> {
  return accountRequest(`/api/items/admin/reports/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ action }),
  });
}

export type DiscoveryFeedbackReason = 'not_interested' | 'too_similar' | 'hide_creator';
export interface DiscoveryFeedback {
  kind: 'item' | 'creator';
  targetId: string;
  reason: DiscoveryFeedbackReason;
  sourceItemId: string;
  sourceItemName: string | null;
  createdAt: number;
}
export async function listDiscoveryFeedback(): Promise<DiscoveryFeedback[]> {
  const result = await accountRequest<{ items: DiscoveryFeedback[] }>(
    '/api/items/discovery-feedback',
  );
  return result.items;
}
export function saveDiscoveryFeedback(
  itemId: string,
  reason: DiscoveryFeedbackReason,
  creatorId?: string,
): Promise<{ kind: 'item' | 'creator'; targetId: string; accountId: string }> {
  return accountRequest(`/api/items/${encodeURIComponent(itemId)}/discovery-feedback`, {
    method: 'PUT',
    body: JSON.stringify({ reason, ...(creatorId ? { creatorId } : {}) }),
  });
}
export function deleteDiscoveryFeedback(kind: 'item' | 'creator', targetId: string): Promise<void> {
  return accountRequest(`/api/items/discovery-feedback/${kind}/${encodeURIComponent(targetId)}`, {
    method: 'DELETE',
  });
}
export function recordCharacterDetailOpen(itemId: string): Promise<unknown> {
  return accountRequest(`/api/items/${encodeURIComponent(itemId)}/character-detail-open`, {
    method: 'POST',
  });
}
export function recordCharacterStart(itemId: string): Promise<unknown> {
  return accountRequest(`/api/items/${encodeURIComponent(itemId)}/character-start`, {
    method: 'POST',
  });
}
export interface CharacterConversionSummary {
  itemId: string;
  itemName: string;
  openedAccounts: number;
  startedAccounts: number;
}
export function fetchCharacterConversions(): Promise<{
  windowDays: number;
  items: CharacterConversionSummary[];
}> {
  return accountRequest('/api/items/admin/character-conversions');
}
