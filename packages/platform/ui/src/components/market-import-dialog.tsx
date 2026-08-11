import { useCallback, useEffect, useId, useState } from 'react';
import { Download, Search, X } from 'lucide-react';
import { Button } from './button';
import { Input } from './input';
import { Overlay } from './overlay-surface';
import {
  fetchMarketItems,
  markMarketDownloaded,
  type MarketItem,
  type MarketItemType,
} from '@0xnullai/market-client';

/**
 * Market import. The app's only copy.
 *
 * Pre-merge Agent / Voice / Chat each had one (144 / 138 / 177 lines),
 * identical in logic, differing only in dialog width and title typography —
 * three copies drifting apart while doing the same thing. Agent's most
 * complete copy is the baseline.
 *
 * Imports land in the shared scene library (`@0xnullai/scenes`): a scene
 * imported in Agent is instantly usable in Voice.
 */
export interface MarketImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  type: MarketItemType;
  // Returns true on successful import; the dialog uses it for feedback.
  onImport: (item: MarketItem) => Promise<void> | void;
}

export function MarketImportDialog({
  open,
  onOpenChange,
  type,
  onImport,
}: MarketImportDialogProps) {
  const [items, setItems] = useState<MarketItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [importedIds, setImportedIds] = useState<Set<string>>(new Set());
  const titleId = useId();
  const descriptionId = useId();

  const load = useCallback(
    async (q: string) => {
      setLoading(true);
      setError(null);
      try {
        const result = await fetchMarketItems({ type, q: q.trim() || undefined, sort: 'popular' });
        setItems(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setItems([]);
      } finally {
        setLoading(false);
      }
    },
    [type],
  );

  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => void load(query), query ? 300 : 0);
    return () => window.clearTimeout(id);
  }, [open, query, load]);

  async function handleImport(item: MarketItem) {
    await onImport(item);
    void markMarketDownloaded(item.id);
    setImportedIds((prev) => new Set(prev).add(item.id));
  }

  const label = type === 'waveform' ? '波形' : '场景';

  if (!open) return null;

  return (
    <Overlay level="stacked" onDismiss={() => onOpenChange(false)} className="backdrop-blur-[2px]">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="relative w-[min(680px,calc(100vw-2rem))] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] shadow-xl"
      >
        <div className="panel-header">
          <div className="min-w-0 flex-1">
            <h2
              id={titleId}
              className="text-[1.1rem] font-semibold tracking-[-0.03em] text-[var(--text)]"
            >
              从市场导入{label}
            </h2>
            <p id={descriptionId} className="mt-1 text-sm text-[var(--text-soft)]">
              浏览社区上传的{label}，一键加入本地库
            </p>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="关闭市场导入"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-ctl)] border border-[var(--surface-border)] text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-soft)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] sm:h-9 sm:w-9"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 pb-5">
          <div className="relative mb-3">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-faint)]" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`搜索${label}名称 / 标签`}
              className="pl-9"
            />
          </div>

          <div className="max-h-[52dvh] space-y-1.5 overflow-y-auto">
            {loading && (
              <div
                role="status"
                aria-live="polite"
                className="py-8 text-center text-sm text-[var(--text-faint)]"
              >
                加载中…
              </div>
            )}
            {error && (
              <div role="alert" className="py-8 text-center text-sm text-[var(--danger)]">
                {error}
                <div className="mt-1 text-[12px] text-[var(--text-faint)]">
                  请确认已部署 Market 并配置了市场地址
                </div>
              </div>
            )}
            {!loading && !error && items.length === 0 && (
              <div className="py-8 text-center text-sm text-[var(--text-faint)]">
                市场里还没有{label}
              </div>
            )}
            {!loading &&
              !error &&
              items.map((item) => {
                const imported = importedIds.has(item.id);
                return (
                  <div
                    key={item.id}
                    className="group flex items-center gap-3 rounded-[var(--radius-ctl)] px-3 py-2.5 hover:bg-[var(--bg-soft)]"
                  >
                    <span className="shrink-0 text-lg">
                      {type === 'scenario' ? item.icon || '🎭' : '〰️'}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-[var(--text)]">{item.name}</div>
                      <div className="mt-0.5 truncate text-[12px] text-[var(--text-faint)]">
                        {item.author ? `@${item.author}` : '匿名'} · ↓ {item.downloads}
                        {item.description ? ` · ${item.description}` : ''}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant={imported ? 'ghost' : 'secondary'}
                      className="shrink-0 gap-1"
                      disabled={imported}
                      onClick={() => void handleImport(item)}
                    >
                      <Download className="h-3.5 w-3.5" />
                      {imported ? '已导入' : '导入'}
                    </Button>
                  </div>
                );
              })}
          </div>
        </div>
      </div>
    </Overlay>
  );
}
