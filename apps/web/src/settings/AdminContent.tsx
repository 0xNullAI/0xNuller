import { useCallback, useEffect, useState } from 'react';
import { Eye, EyeOff, Search, Trash2 } from 'lucide-react';
import { Button, Input } from '@0xnullai/ui';
import { getAdminStats, type AdminStats } from '@0xnullai/auth';
import type { MarketAdminItem } from '../../../market/src/shared/schema';
import {
  deleteItem,
  fetchAdminItems,
  setItemHidden,
  type AdminItemStatus,
  type AdminItemType,
} from '../../../market/src/web/api';

const CATEGORIES: Array<{ id: AdminItemType; label: string }> = [
  { id: 'waveform', label: '波形' },
  { id: 'scenario', label: '场景' },
];

const FILTERS: Array<{ id: AdminItemStatus; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'visible', label: '公开' },
  { id: 'hidden', label: '已隐藏' },
];

export function AdminContent() {
  const [type, setType] = useState<AdminItemType>('waveform');
  const [status, setStatus] = useState<AdminItemStatus>('all');
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<MarketAdminItem[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<AdminStats | null>(null);

  const requestPage = useCallback(
    (offset = 0) => fetchAdminItems({ type, status, q: query || undefined, offset, limit: 20 }),
    [query, status, type],
  );

  const load = useCallback(
    async (offset = 0, append = false) => {
      setLoading(true);
      setError(null);
      try {
        const page = await requestPage(offset);
        setItems((current) => (append ? [...current, ...page.items] : page.items));
        setNextOffset(page.nextOffset);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '加载失败');
      } finally {
        setLoading(false);
      }
    },
    [requestPage],
  );

  useEffect(() => {
    let active = true;
    void requestPage()
      .then((page) => {
        if (!active) return;
        setItems(page.items);
        setNextOffset(page.nextOffset);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : '加载失败');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [requestPage]);

  useEffect(() => {
    void getAdminStats()
      .then(setStats)
      .catch(() => undefined);
  }, []);

  async function updateVisibility(item: MarketAdminItem) {
    setBusyId(item.id);
    setError(null);
    try {
      await setItemHidden(item.id, !item.hidden);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败');
    } finally {
      setBusyId(null);
    }
  }

  async function remove(item: MarketAdminItem) {
    if (!window.confirm(`永久删除「${item.name}」？`)) return;
    setBusyId(item.id);
    setError(null);
    try {
      await deleteItem(item.id);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除失败');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section aria-labelledby="admin-content-title">
      {stats ? (
        <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {[
            ['账户', stats.users],
            ['已验证', stats.verifiedUsers],
            ['活跃会话', stats.activeSessions],
            ['24h 注册尝试', stats.registrationAttempts24h],
            ['今日文本体验', stats.textUnitsToday],
            ['今日语音体验', stats.voiceUnitsToday],
          ].map(([label, value]) => (
            <div
              key={String(label)}
              className="rounded-[var(--radius-sm)] border border-[var(--surface-border)] p-3"
            >
              <div className="text-xs text-[var(--text-faint)]">{label}</div>
              <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="admin-content-title" className="text-lg font-semibold">
            内容管理
          </h2>
          <p className="mt-1 text-xs text-[var(--text-faint)]">Market</p>
        </div>
        <div
          aria-label="内容分类"
          className="flex rounded-[var(--radius-ctl)] border border-[var(--surface-border)] p-1"
        >
          {CATEGORIES.map((category) => (
            <button
              key={category.id}
              type="button"
              aria-pressed={type === category.id}
              onClick={() => {
                if (type === category.id) {
                  void load();
                  return;
                }
                setLoading(true);
                setType(category.id);
              }}
              className={
                'min-h-[36px] rounded-[calc(var(--radius-ctl)-4px)] px-3 text-xs font-medium transition-colors ' +
                (type === category.id
                  ? 'bg-[var(--accent-soft)] text-[var(--text)]'
                  : 'text-[var(--text-soft)] hover:text-[var(--text)]')
              }
            >
              {category.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 flex justify-end">
        <div
          aria-label="可见性"
          className="flex rounded-[var(--radius-ctl)] border border-[var(--surface-border)] p-1"
        >
          {FILTERS.map((filter) => (
            <button
              key={filter.id}
              type="button"
              aria-pressed={status === filter.id}
              onClick={() => {
                if (status === filter.id) {
                  void load();
                  return;
                }
                setLoading(true);
                setStatus(filter.id);
              }}
              className={
                'min-h-[36px] rounded-[calc(var(--radius-ctl)-4px)] px-3 text-xs font-medium transition-colors ' +
                (status === filter.id
                  ? 'bg-[var(--accent-soft)] text-[var(--text)]'
                  : 'text-[var(--text-soft)] hover:text-[var(--text)]')
              }
            >
              {filter.label}
            </button>
          ))}
        </div>
      </div>

      <form
        className="mt-4 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const nextQuery = draft.trim();
          if (nextQuery === query) {
            void load();
            return;
          }
          setLoading(true);
          setQuery(nextQuery);
        }}
      >
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="名称、作者"
          aria-label="搜索内容"
        />
        <Button type="submit" variant="secondary" aria-label="搜索">
          <Search className="h-4 w-4" />
        </Button>
      </form>

      {error ? (
        <p role="alert" className="mt-4 text-sm text-[var(--danger)]">
          {error}
        </p>
      ) : null}

      <div className="mt-4 space-y-2">
        {items.map((item) => (
          <article
            key={item.id}
            className="rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--bg-soft)] p-3"
          >
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="truncate text-sm font-semibold">{item.name}</h3>
                  {item.hidden ? (
                    <span className="rounded-full bg-[var(--danger-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--danger)]">
                      已隐藏
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-xs text-[var(--text-faint)]">
                  {item.type} · {item.author ? `@${item.author}` : '未署名'}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <button
                  type="button"
                  disabled={busyId === item.id}
                  onClick={() => void updateVisibility(item)}
                  aria-label={item.hidden ? `恢复 ${item.name}` : `隐藏 ${item.name}`}
                  className="flex min-h-[40px] min-w-[40px] items-center justify-center rounded-[var(--radius-ctl)] text-[var(--text-soft)] hover:bg-[var(--accent-soft)] hover:text-[var(--text)] disabled:opacity-50"
                >
                  {item.hidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                </button>
                <button
                  type="button"
                  disabled={busyId === item.id}
                  onClick={() => void remove(item)}
                  aria-label={`删除 ${item.name}`}
                  className="flex min-h-[40px] min-w-[40px] items-center justify-center rounded-[var(--radius-ctl)] text-[var(--danger)] hover:bg-[var(--danger-soft)] disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>

      {!loading && items.length === 0 ? (
        <p role="status" className="mt-8 text-center text-sm text-[var(--text-faint)]">
          没有内容
        </p>
      ) : null}
      {loading ? (
        <p role="status" className="mt-6 text-center text-sm text-[var(--text-faint)]">
          加载中…
        </p>
      ) : null}
      {!loading && nextOffset !== null ? (
        <Button
          variant="secondary"
          className="mt-4 w-full"
          onClick={() => void load(nextOffset, true)}
        >
          加载更多
        </Button>
      ) : null}
    </section>
  );
}
