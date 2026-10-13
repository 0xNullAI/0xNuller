// Community market client — single platform source of truth.
//
// Shared by Agent, Chat, and Voice. Retired multiplayer scenes are deliberately
// absent from the public client contract; historical imports are handled by
// their legacy parsers, not by the live Market browser.
//
// Market endpoints live under `/api/items` on the unified domain, so only
// the origin is needed: empty string on the web (same-origin); the Tauri
// shell gets an absolute origin from apiBaseUrl(). Self-hosted deployments
// override with VITE_API_BASE_URL.

import { apiBaseUrl } from '@0xnullai/settings';
import { authRequestHeaders, currentAuthUserId } from '@0xnullai/auth';
import type { WaveformModality } from '@dg-kit/core';
import { sharedPortraitRead } from './portrait-cache.js';

export type { WaveformModality } from '@dg-kit/core';

export const marketBaseUrl = (): string => apiBaseUrl();

export type MarketItemType = 'waveform' | 'scenario';

export interface MarketWaveformContent {
  // Waveform frames: [encoded frequency 10-240, strength 0-100][] —
  // identical to @dg-kit/core's WaveFrame.
  frames: [number, number][];
  modality?: WaveformModality;
  pulse?: string;
}

export interface MarketScenarioContent {
  prompt: string;
  kind?: 'character' | 'scene';
  /** Untrusted public metadata; importers validate with the scenes character-card parser. */
  characterCard?: unknown;
  /** Public Market asset ID, never a private photo ID or remote URL. */
  portraitId?: string;
  /** Market annotation for prompts above the ordinary 12,000-character tier. */
  scale?: 'extra-large';
}

export interface MarketItem {
  id: string;
  /** Present on servers with public-card version history; older servers may omit it. */
  revision?: number;
  type: MarketItemType;
  name: string;
  description?: string;
  author?: string;
  icon?: string;
  tags: string[];
  content: MarketWaveformContent | MarketScenarioContent;
  downloads: number;
  createdAt: number;
}

export interface FetchMarketParams {
  type: MarketItemType;
  /** Optional output-family filter for waveform imports. */
  modality?: WaveformModality;
  q?: string;
  sort?: 'new' | 'popular';
  limit?: number;
  // Optional abort signal so the UI can time out / interrupt.
  signal?: AbortSignal;
}

export async function fetchMarketItems(params: FetchMarketParams): Promise<MarketItem[]> {
  const search = new URLSearchParams({ type: params.type });
  if (params.modality && params.type === 'waveform') search.set('modality', params.modality);
  if (params.q) search.set('q', params.q);
  if (params.sort) search.set('sort', params.sort);
  search.set('limit', String(params.limit ?? 50));

  const res = await fetch(`${marketBaseUrl()}/api/items?${search.toString()}`, {
    signal: params.signal,
  });
  if (!res.ok) throw new Error(`市场请求失败 (${res.status})`);
  const data = (await res.json()) as { items?: MarketItem[] };
  // Treat the remote list as untrusted, including older Market deployments.
  return (data.items ?? []).filter((item) => item.type === params.type);
}

/** Fetch the latest visible public item before offering an opt-in update. */
export async function fetchMarketItem(id: string): Promise<MarketItem> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new Error('市场条目编号无效');
  const res = await fetch(`${marketBaseUrl()}/api/items/${encodeURIComponent(id)}`, {
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`市场条目无法读取 (${res.status})`);
  const data = (await res.json()) as { item?: MarketItem };
  if (!data.item || data.item.id !== id) throw new Error('市场返回的条目不匹配');
  if (data.item.type !== 'waveform' && data.item.type !== 'scenario')
    throw new Error('市场条目类型已下线');
  return data.item;
}

/** Verified public works on a signed-in user's profile, never the editable author string. */
export async function fetchCreatorMarketItems(
  creatorId: string,
  accountId: string,
  signal?: AbortSignal,
): Promise<MarketItem[]> {
  if (!/^[\w-]{1,128}$/.test(creatorId)) throw new Error('作者编号无效');
  if (!accountId || currentAuthUserId() !== accountId) throw new Error('账号已切换');
  const search = new URLSearchParams({ mode: 'creator', creatorId });
  const response = await fetch(`${marketBaseUrl()}/api/items/discovery?${search}`, {
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    headers: { ...authRequestHeaders(), 'X-Account-Id': accountId },
  });
  if (!response.ok) throw new Error(`作者作品暂不可用 (${response.status})`);
  const data = (await response.json()) as { accountId?: string; items?: MarketItem[] };
  if (currentAuthUserId() !== accountId || data.accountId !== accountId)
    throw new Error('账号已切换');
  if (!Array.isArray(data.items)) throw new Error('作者作品响应无效');
  return data.items.filter(
    (item) =>
      item &&
      (item.type === 'scenario' || item.type === 'waveform') &&
      typeof item.id === 'string' &&
      /^[\w-]{1,128}$/.test(item.id),
  );
}

export async function markMarketDownloaded(id: string): Promise<void> {
  await fetch(`${marketBaseUrl()}/api/items/${id}/download`, { method: 'POST' }).catch(() => {});
}

/** UUID-only reference; never accepts an arbitrary image URL. */
export function parseMarketPortraitId(value: unknown): string | null {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : null;
}
export function marketPortraitUrl(value: unknown): string | null {
  const id = parseMarketPortraitId(value);
  return id ? `${marketBaseUrl()}/api/items/character-portraits/${id}/content` : null;
}
/** Anonymous read deliberately excludes the author's private preview privilege.
 * null means use the local emoji/default avatar. Abort remains cancellation (of this caller's
 * wait; the read itself is shared by every avatar showing the same portrait). */
export async function fetchPublicMarketPortrait(
  value: unknown,
  signal?: AbortSignal,
): Promise<Blob | null> {
  const url = marketPortraitUrl(value);
  if (!url) return null;
  return sharedPortraitRead(url, signal, async () => {
    try {
      const response = await fetch(url, { credentials: 'omit', cache: 'no-store' });
      if (!response.ok) return null;
      const type = response.headers.get('Content-Type')?.split(';')[0]?.trim();
      if (!type || !['image/png', 'image/jpeg', 'image/webp'].includes(type)) return null;
      const blob = await response.blob();
      return blob.size > 0 && blob.size <= 4 * 1024 * 1024 ? blob : null;
    } catch {
      return null;
    }
  });
}
