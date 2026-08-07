// DG-Market 社区市场客户端：拉取他人上传的波形，供「从市场导入」使用。
// 改编自 DG-Agent 的 apps/web/src/lib/market.ts，DG-Chat 仅需要波形条目。
// 默认指向官方市场地址，可通过 VITE_MARKET_BASE_URL 覆盖（部署私有 DG-Market 时）。

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
