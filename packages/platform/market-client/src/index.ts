// DG-Market 社区市场客户端 —— 平台单一真源。
//
// 合并前 agent / chat / voice 各有一份：agent 覆盖 waveform+scenario、voice 只用
// scenario、chat 额外支持 multi-scene 与 AbortSignal。这里以 chat 那份（严格超集）
// 为基准，三个模块共用。
//
// 部署自己的 DG-Market 时用 VITE_MARKET_BASE_URL 覆盖，或直接改下面的兜底常量。

const FALLBACK_BASE_URL = 'https://market.0xnullai.com';

export const MARKET_BASE_URL: string =
  (import.meta.env.VITE_MARKET_BASE_URL as string | undefined)?.replace(/\/$/, '') ??
  FALLBACK_BASE_URL;

export type MarketItemType = 'waveform' | 'scenario' | 'multi-scene';

export interface MarketWaveformContent {
  // 波形帧：[编码频率 10-240, 强度 0-100][]，与 @dg-kit/core 的 WaveFrame 完全一致。
  frames: [number, number][];
  pulse?: string;
}

export interface MarketScenarioContent {
  prompt: string;
}

/** 多人场景：世界观 + 角色 + 玩法元数据。 */
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
  q?: string;
  sort?: 'new' | 'popular';
  limit?: number;
  // 可选的取消信号，供 UI 做超时/打断。
  signal?: AbortSignal;
}

export async function fetchMarketItems(params: FetchMarketParams): Promise<MarketItem[]> {
  const search = new URLSearchParams({ type: params.type });
  if (params.q) search.set('q', params.q);
  if (params.sort) search.set('sort', params.sort);
  search.set('limit', String(params.limit ?? 50));

  const res = await fetch(`${MARKET_BASE_URL}/api/items?${search.toString()}`, {
    signal: params.signal,
  });
  if (!res.ok) throw new Error(`市场请求失败 (${res.status})`);
  const data = (await res.json()) as { items?: MarketItem[] };
  // 按请求的 type 过滤（waveform / multi-scene…）。
  return (data.items ?? []).filter((item) => item.type === params.type);
}

export async function markMarketDownloaded(id: string): Promise<void> {
  await fetch(`${MARKET_BASE_URL}/api/items/${id}/download`, { method: 'POST' }).catch(() => {});
}
