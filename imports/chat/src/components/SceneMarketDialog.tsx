import { useState, useEffect, useCallback } from 'react';
import { Search, X, Download } from 'lucide-react';
import { fetchMarketItems, markMarketDownloaded, type MarketItem, type MarketMultiSceneContent } from '../lib/market';
import type { Scene } from '../lib/protocol';

function genId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

/** 市场多人场景条目 → 房间 Scene（补本地角色 id）。 */
function toScene(item: MarketItem): Scene {
  const c = item.content as MarketMultiSceneContent;
  return {
    id: `market-${item.id}`,
    name: item.name,
    setting: c.setting,
    roles: (c.roles ?? []).map(r => ({
      id: genId(),
      name: r.name,
      description: r.description,
      aiPlayable: r.aiPlayable,
    })),
    playerCount: c.playerCount,
  };
}

interface Props {
  open: boolean;
  onClose: () => void;
  onImport: (scene: Scene) => void;
}

export function SceneMarketDialog({ open, onClose, onImport }: Props) {
  const [items, setItems] = useState<MarketItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const load = useCallback(async (q: string) => {
    setLoading(true);
    setError(null);
    try {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 8000);
      try {
        const res = await fetchMarketItems({ type: 'multi-scene', q: q.trim() || undefined, sort: 'popular', signal: controller.signal });
        setItems(res);
      } finally {
        window.clearTimeout(timer);
      }
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === 'AbortError';
      setError(aborted ? '请求超时，请稍后重试' : err instanceof Error ? err.message : '网络请求失败');
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => void load(query), query ? 300 : 0);
    return () => window.clearTimeout(id);
  }, [open, query, load]);

  if (!open) return null;

  function handleImport(item: MarketItem) {
    onImport(toScene(item));
    void markMarketDownloaded(item.id);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onMouseDown={onClose} role="presentation">
      <div
        role="dialog"
        aria-label="从市场导入场景"
        className="flex max-h-[80vh] w-[min(560px,calc(100vw-32px))] flex-col overflow-hidden rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] shadow-2xl"
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-[var(--surface-border)] px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-[var(--text)]">从市场导入场景</p>
            <p className="mt-0.5 text-xs text-[var(--text-faint)]">浏览社区多人场景，一键应用为房间场景</p>
          </div>
          <button onClick={onClose} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-soft)] hover:bg-[var(--bg-soft)]" aria-label="关闭">
            <X size={14} />
          </button>
        </div>

        <div className="px-4 pt-3">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-faint)]" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="搜索场景名 / 标签"
              className="w-full rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--bg)] py-2 pl-9 pr-3 text-sm text-[var(--text)] outline-none transition-colors focus:border-[var(--accent)]"
              style={{ fontSize: '16px' }}
            />
          </div>
        </div>

        <div className="mt-2 flex-1 space-y-1 overflow-y-auto px-3 pb-3">
          {loading && <div className="py-10 text-center text-sm text-[var(--text-faint)]">加载中…</div>}
          {!loading && error && (
            <div className="py-10 text-center">
              <p className="text-sm text-[var(--danger)]">{error}</p>
              <button onClick={() => void load(query)} className="mt-2 rounded-[var(--radius-sm)] px-3 py-1 text-xs text-[var(--accent)] hover:bg-[var(--accent-soft)]">
                重试
              </button>
            </div>
          )}
          {!loading && !error && items.length === 0 && (
            <div className="py-10 text-center text-sm text-[var(--text-faint)]">{query ? '没有匹配的场景' : '市场里还没有多人场景'}</div>
          )}
          {!loading && !error && items.map(item => {
            const c = item.content as MarketMultiSceneContent;
            return (
              <div key={item.id} className="flex items-center gap-3 rounded-[var(--radius-sm)] px-3 py-2.5 transition-colors hover:bg-[var(--bg-soft)]">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-[var(--text)]">
                    {item.icon || '🎬'} {item.name}
                  </p>
                  <p className="mt-0.5 truncate text-[11px] text-[var(--text-faint)]">
                    {c.roles?.length ?? 0} 角色
                    {c.playerCount ? ` · ${c.playerCount.min}-${c.playerCount.max} 人` : ''} · 下载 {item.downloads}
                  </p>
                </div>
                <button
                  onClick={() => handleImport(item)}
                  className="flex shrink-0 items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--accent-soft)] px-2.5 py-1.5 text-xs text-[var(--accent)] hover:opacity-90"
                >
                  <Download size={13} /> 导入
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
