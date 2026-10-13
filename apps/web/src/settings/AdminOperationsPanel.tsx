import { useCallback, useEffect, useState } from 'react';
import { Eye, EyeOff, Search, Trash2 } from 'lucide-react';
import { getAdminReports, resolveAdminReport, type UserReport } from '@0xnullai/auth';
import { Button, Input, SegmentedControl } from '@0xnullai/ui';
import type { MarketAdminItem } from '../../../market/src/shared/schema';
import {
  deleteItem,
  fetchAdminItems,
  setItemHidden,
  type AdminItemStatus,
  type AdminItemType,
} from '../../../market/src/web/api';
import { AdminCard, errorText } from './AdminCard';
import { RuntimeHealthPanel } from './RuntimeHealthPanel';

const CATEGORIES: readonly (readonly [AdminItemType, string])[] = [
  ['waveform', '波形'],
  ['scenario', '场景'],
];

const FILTERS: readonly (readonly [AdminItemStatus, string])[] = [
  ['all', '全部'],
  ['visible', '公开'],
  ['hidden', '已隐藏'],
];

export function AdminOperationsPanel() {
  return (
    <>
      <Reports />
      <MarketModeration />
      <RuntimeHealthPanel />
    </>
  );
}

function Reports() {
  const [reports, setReports] = useState<UserReport[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getAdminReports()
      .then((value) => active && setReports(value))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  async function resolve(report: UserReport, status: 'dismissed' | 'reviewed') {
    setError(null);
    try {
      await resolveAdminReport(report.id, status);
      setReports((current) =>
        current.map((item) => (item.id === report.id ? { ...item, status } : item)),
      );
    } catch (cause) {
      setError(errorText(cause, '操作失败'));
    }
  }

  const open = reports.filter((report) => report.status === 'open');
  return (
    <AdminCard title="用户举报">
      {error ? (
        <p role="alert" className="mb-2 text-xs text-[var(--danger)]">
          {error}
        </p>
      ) : null}
      {open.length === 0 ? (
        <p className="text-xs text-[var(--text-faint)]">暂无待处理举报</p>
      ) : null}
      <div className="space-y-2">
        {open.map((report) => (
          <div key={report.id} className="rounded-[var(--radius-xs)] bg-[var(--bg)] p-2 text-xs">
            <div className="font-medium">
              @{report.reported_username} · {report.reason}
            </div>
            <div className="mt-0.5 text-[var(--text-faint)]">
              举报人 @{report.reporter_username}
            </div>
            {report.details ? (
              <p className="mt-1 text-[var(--text-soft)]">{report.details}</p>
            ) : null}
            <div className="mt-2 flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => void resolve(report, 'dismissed')}>
                忽略
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void resolve(report, 'reviewed')}
              >
                标记已处理
              </Button>
            </div>
          </div>
        ))}
      </div>
    </AdminCard>
  );
}

function MarketModeration() {
  const [type, setType] = useState<AdminItemType>('waveform');
  const [status, setStatus] = useState<AdminItemStatus>('all');
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<MarketAdminItem[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        setError(errorText(cause, '加载失败'));
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
        if (active) setError(errorText(cause, '加载失败'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [requestPage]);

  async function updateVisibility(item: MarketAdminItem) {
    setBusyId(item.id);
    setError(null);
    try {
      await setItemHidden(item.id, !item.hidden);
      await load();
    } catch (cause) {
      setError(errorText(cause, '操作失败'));
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
      setError(errorText(cause, '删除失败'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <AdminCard
      title="Market 内容"
      actions={
        <>
          <SegmentedControl
            label="内容分类"
            value={type}
            onChange={(next) => {
              if (next === type) return void load();
              setLoading(true);
              setType(next);
            }}
            options={CATEGORIES}
          />
          <SegmentedControl
            label="可见性"
            value={status}
            onChange={(next) => {
              if (next === status) return void load();
              setLoading(true);
              setStatus(next);
            }}
            options={FILTERS}
          />
        </>
      }
    >
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const nextQuery = draft.trim();
          if (nextQuery === query) return void load();
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
        <p role="alert" className="mt-3 text-sm text-[var(--danger)]">
          {error}
        </p>
      ) : null}

      <div className="mt-3 space-y-2">
        {items.map((item) => (
          <article
            key={item.id}
            className="rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--bg)] p-3"
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
        <p role="status" className="mt-6 text-center text-sm text-[var(--text-faint)]">
          没有内容
        </p>
      ) : null}
      {loading ? (
        <p role="status" className="mt-4 text-center text-sm text-[var(--text-faint)]">
          加载中…
        </p>
      ) : null}
      {!loading && nextOffset !== null ? (
        <Button
          variant="secondary"
          className="mt-3 w-full"
          onClick={() => void load(nextOffset, true)}
        >
          加载更多
        </Button>
      ) : null}
    </AdminCard>
  );
}
