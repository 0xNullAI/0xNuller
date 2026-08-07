import { useCallback, useEffect, useState } from 'react';
import { Download, Search, X } from 'lucide-react';
import { fetchMarketItems, markMarketDownloaded, type MarketItem } from '../lib/market';

interface MarketImportDialogProps {
  open: boolean;
  onClose: () => void;
  // 把选中的市场条目导入本地库（去重由上层 hook 负责）。
  onImport: (item: MarketItem) => void;
}

export function MarketImportDialog({ open, onClose, onImport }: MarketImportDialogProps) {
  const [items, setItems] = useState<MarketItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [importedIds, setImportedIds] = useState<Set<string>>(new Set());

  const load = useCallback(async (q: string) => {
    setLoading(true);
    setError(null);
    try {
      // 8 秒超时，避免市场不可达时一直转圈。
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 8000);
      try {
        const result = await fetchMarketItems({
          type: 'waveform',
          q: q.trim() || undefined,
          sort: 'popular',
          signal: controller.signal,
        });
        setItems(result);
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

  // 打开时立即拉一次；输入变化时防抖 300ms。
  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => void load(query), query ? 300 : 0);
    return () => window.clearTimeout(id);
  }, [open, query, load]);

  // 关闭时重置搜索词与已导入标记，下次打开是干净状态。
  const handleClose = useCallback(() => {
    setQuery('');
    setImportedIds(new Set());
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, handleClose]);

  function handleImport(item: MarketItem) {
    onImport(item);
    void markMarketDownloaded(item.id);
    setImportedIds(prev => new Set(prev).add(item.id));
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={handleClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-label="从市场导入波形"
        className="flex max-h-[80vh] w-[min(560px,calc(100vw-32px))] flex-col overflow-hidden rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] shadow-2xl"
        onMouseDown={e => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-start justify-between border-b border-[var(--surface-border)] px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-[var(--text)]">从市场导入波形</p>
            <p className="mt-0.5 text-xs text-[var(--text-faint)]">浏览社区上传的波形，一键加入本地库</p>
          </div>
          <button
            onClick={handleClose}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-soft)] hover:bg-[var(--bg-soft)]"
            aria-label="关闭"
          >
            <X size={14} />
          </button>
        </div>

        {/* 搜索框 */}
        <div className="px-4 pt-3">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-faint)]" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="搜索波形名称 / 标签"
              className="w-full rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--bg)] py-2 pl-9 pr-3 text-sm text-[var(--text)] outline-none transition-colors focus:border-[var(--accent)]"
            />
          </div>
        </div>

        {/* 列表 */}
        <div className="mt-2 flex-1 space-y-1 overflow-y-auto px-3 pb-3">
          {loading && (
            <div className="py-10 text-center text-sm text-[var(--text-faint)]">加载中…</div>
          )}
          {!loading && error && (
            <div className="py-10 text-center">
              <p className="text-sm text-[var(--danger)]">{error}</p>
              <button
                onClick={() => void load(query)}
                className="mt-2 rounded-[var(--radius-sm)] px-3 py-1 text-xs text-[var(--accent)] hover:bg-[var(--accent-soft)]"
              >
                重试
              </button>
            </div>
          )}
          {!loading && !error && items.length === 0 && (
            <div className="py-10 text-center text-sm text-[var(--text-faint)]">
              {query ? '没有匹配的波形' : '市场里还没有波形'}
            </div>
          )}
          {!loading && !error && items.map(item => {
            const imported = importedIds.has(item.id);
            return (
              <div
                key={item.id}
                className="flex items-center gap-3 rounded-[var(--radius-sm)] px-3 py-2.5 transition-colors hover:bg-[var(--bg-soft)]"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-[var(--text)]">{item.name}</p>
                  <p className="mt-0.5 truncate text-[11px] text-[var(--text-faint)]">
                    {item.author ? `@${item.author}` : '匿名'} · 下载 {item.downloads}
                    {item.description ? ` · ${item.description}` : ''}
                  </p>
                </div>
                <button
                  onClick={() => handleImport(item)}
                  disabled={imported}
                  className={`flex shrink-0 items-center gap-1 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-xs transition-colors ${
                    imported
                      ? 'text-[var(--text-faint)]'
                      : 'bg-[var(--accent-soft)] text-[var(--accent)] hover:bg-[var(--accent-hover)]'
                  }`}
                >
                  <Download size={13} />
                  {imported ? '已导入' : '导入'}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
