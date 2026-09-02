// Community market client — single platform source of truth.
//
// Pre-merge, agent / chat / voice each had a copy: agent covered
// waveform+scenario, voice used scenario only, chat additionally supported
// multi-scene and AbortSignal. This takes chat's copy (a strict superset)
// as the baseline, shared by all three modules.
//
// Market endpoints live under `/api/items` on the unified domain, so only
// the origin is needed: empty string on the web (same-origin); the Tauri
// shell gets an absolute origin from apiBaseUrl(). Self-hosted deployments
// override with VITE_API_BASE_URL.

import { apiBaseUrl } from '@0xnullai/settings';
import type { WaveformModality } from '@dg-kit/core';

export type { WaveformModality } from '@dg-kit/core';

export const marketBaseUrl = (): string => apiBaseUrl();

export type MarketItemType = 'waveform' | 'scenario' | 'multi-scene';

export interface MarketWaveformContent {
  // Waveform frames: [encoded frequency 10-240, strength 0-100][] —
  // identical to @dg-kit/core's WaveFrame.
  frames: [number, number][];
  modality?: WaveformModality;
  pulse?: string;
}

export interface MarketScenarioContent {
  prompt: string;
  /** Market annotation for prompts above the ordinary 12,000-character tier. */
  scale?: 'extra-large';
}

/** Multi-player scene: worldview + roles + gameplay metadata. */
export interface MarketMultiSceneContent {
  setting: string;
  roles: { name: string; description?: string; aiPlayable?: boolean }[];
  playerCount?: { min: number; max: number };
  aiMode?: 'none' | 'solo' | 'multi';
}

export interface MarketItem {
  id: string;
  type: MarketItemType;
  name: string;
  description?: string;
  author?: string;
  icon?: string;
  tags: string[];
  content: MarketWaveformContent | MarketScenarioContent | MarketMultiSceneContent;
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
  // Filter by the requested type (waveform / multi-scene / ...).
  return (data.items ?? []).filter((item) => item.type === params.type);
}

export async function markMarketDownloaded(id: string): Promise<void> {
  await fetch(`${marketBaseUrl()}/api/items/${id}/download`, { method: 'POST' }).catch(() => {});
}
