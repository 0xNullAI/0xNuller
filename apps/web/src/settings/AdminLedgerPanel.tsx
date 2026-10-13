import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Search, X } from 'lucide-react';
import {
  getAdminLedgerSummary,
  listAdminLedger,
  type AdminLedgerEntry,
  type AdminLedgerFilter,
  type AdminLedgerSummary,
  type LedgerGroup,
} from '@0xnullai/auth';
import { Button, Input, SegmentedControl } from '@0xnullai/ui';
import { AdminCard, errorText } from './AdminCard';
import {
  LEDGER_GROUPS,
  RANGE_PRESETS,
  creditTone,
  formatSignedCredits,
  formatTime,
  ledgerFilter,
  ledgerGroupLabel,
  ledgerRange,
  type RangePreset,
} from './admin-billing-view';

const TONE_CLASS = {
  in: 'text-[var(--success)]',
  out: 'text-[var(--danger)]',
  none: 'text-[var(--text-soft)]',
} as const;

function Signed({ credits }: { credits: number }) {
  return (
    <span className={`tabular-nums ${TONE_CLASS[creditTone(credits)]}`}>
      {formatSignedCredits(credits)}
    </span>
  );
}

/** Every ledger row across accounts, filtered by user, group and China-time day range. */
export function AdminLedgerPanel({
  username,
  onUsernameChange,
}: {
  username: string;
  onUsernameChange: (username: string) => void;
}) {
  const [draft, setDraft] = useState(username);
  const [group, setGroup] = useState<LedgerGroup | ''>('');
  const [preset, setPreset] = useState<RangePreset>('7d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [entries, setEntries] = useState<AdminLedgerEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [summary, setSummary] = useState<AdminLedgerSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  // The filter the visible page was loaded with, so 加载更多 continues the same query.
  const active = useRef<{ filter: AdminLedgerFilter; seq: number }>({ filter: {}, seq: 0 });

  useEffect(() => {
    const filter = ledgerFilter({
      username,
      group,
      range: ledgerRange(preset, Date.now(), { from: customFrom, to: customTo }),
    });
    const seq = active.current.seq + 1;
    active.current = { filter, seq };
    const current = () => active.current.seq === seq;
    void listAdminLedger(filter)
      .then((page) => {
        if (!current()) return;
        setEntries(page.entries);
        setNextCursor(page.nextCursor);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!current()) return;
        setEntries([]);
        setNextCursor(null);
        setError(errorText(cause, '账单加载失败'));
      })
      .finally(() => {
        if (current()) setLoading(false);
      });
    void getAdminLedgerSummary(filter)
      .then((value) => {
        if (!current()) return;
        setSummary(value);
        setSummaryError(null);
      })
      .catch((cause: unknown) => {
        if (!current()) return;
        setSummary(null);
        setSummaryError(errorText(cause, '汇总加载失败'));
      });
  }, [username, group, preset, customFrom, customTo, refresh]);

  useEffect(
    () => () => {
      // Drop late responses after unmount.
      active.current.seq += 1;
    },
    [],
  );

  async function more() {
    if (nextCursor === null || loading) return;
    const { filter, seq } = active.current;
    setLoading(true);
    try {
      const page = await listAdminLedger(filter, nextCursor);
      if (active.current.seq !== seq) return;
      setEntries((old) => [...old, ...page.entries.filter((e) => !old.some((o) => o.id === e.id))]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      if (active.current.seq === seq) setError(errorText(cause, '账单加载失败'));
    } finally {
      if (active.current.seq === seq) setLoading(false);
    }
  }

  function filterUser(next: string) {
    const value = next.trim().replace(/^@+/, '');
    setDraft(value);
    if (value === username) return;
    setLoading(true);
    onUsernameChange(value);
  }

  const groupsInSummary = LEDGER_GROUPS.filter(([id]) => summary?.totals[id]);

  return (
    <>
      <AdminCard
        title="账单"
        actions={
          <Button
            size="sm"
            variant="ghost"
            aria-label="刷新账单"
            disabled={loading}
            onClick={() => {
              setLoading(true);
              setRefresh((x) => x + 1);
            }}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        }
      >
        <div className="flex flex-col gap-2">
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              filterUser(draft);
            }}
          >
            <Input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="用户名（留空为全部）"
              aria-label="按用户名筛选"
            />
            {username ? (
              <Button
                type="button"
                variant="ghost"
                aria-label="清除用户筛选"
                onClick={() => filterUser('')}
              >
                <X className="h-4 w-4" />
              </Button>
            ) : null}
            <Button type="submit" variant="secondary" aria-label="筛选用户">
              <Search className="h-4 w-4" />
            </Button>
          </form>
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl
              label="时间范围"
              value={preset}
              onChange={(next) => {
                if (next === preset) return;
                setLoading(true);
                setPreset(next);
              }}
              options={RANGE_PRESETS}
            />
            <select
              aria-label="类别"
              value={group}
              onChange={(event) => {
                setLoading(true);
                setGroup(event.target.value as LedgerGroup | '');
              }}
              className="min-h-[32px] rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-strong)] px-2 text-xs"
            >
              <option value="">全部类别</option>
              {LEDGER_GROUPS.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          {preset === 'custom' ? (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Input
                type="date"
                value={customFrom}
                onChange={(event) => {
                  setLoading(true);
                  setCustomFrom(event.target.value);
                }}
                aria-label="开始日期"
                className="w-auto"
              />
              <span className="text-[var(--text-faint)]">至</span>
              <Input
                type="date"
                value={customTo}
                onChange={(event) => {
                  setLoading(true);
                  setCustomTo(event.target.value);
                }}
                aria-label="结束日期"
                className="w-auto"
              />
            </div>
          ) : null}
        </div>
      </AdminCard>

      <section aria-label="每日汇总" className="flex min-w-0 flex-col gap-2">
        {summaryError ? (
          <p role="alert" className="text-xs text-[var(--danger)]">
            {summaryError}
          </p>
        ) : null}
        {summary && groupsInSummary.length > 0 ? (
          <div className="flex flex-wrap gap-x-3 gap-y-1 px-1 text-xs">
            <span className="font-medium">合计</span>
            {groupsInSummary.map(([id, label]) => (
              <span key={id}>
                <span className="text-[var(--text-faint)]">{label} </span>
                <Signed credits={summary.totals[id]!.credits} />
              </span>
            ))}
          </div>
        ) : null}
        {summary && summary.days.length > 0 ? (
          <div className="flex gap-2 overflow-x-auto pb-1">
            {summary.days.map((day) => (
              <div
                key={day.date}
                data-testid="ledger-day"
                className="min-w-[132px] shrink-0 rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--bg-soft)] p-2 text-xs"
              >
                <div className="font-medium tabular-nums">{day.date}</div>
                <dl className="mt-1 space-y-0.5">
                  {LEDGER_GROUPS.filter(([id]) => day.groups[id]).map(([id, label]) => (
                    <div key={id} className="flex justify-between gap-2">
                      <dt className="text-[var(--text-faint)]">{label}</dt>
                      <dd>
                        <Signed credits={day.groups[id]!.credits} />
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      {error ? (
        <p role="alert" className="text-sm text-[var(--danger)]">
          {error}
        </p>
      ) : null}

      <div className="min-w-0 overflow-x-auto rounded-[var(--radius-sm)] border border-[var(--surface-border)]">
        <table className="w-full min-w-[560px] text-left text-xs">
          <thead className="bg-[var(--bg-soft)] text-[var(--text-faint)]">
            <tr>
              <th className="px-3 py-2 font-medium">时间</th>
              <th className="px-3 py-2 font-medium">用户</th>
              <th className="px-3 py-2 font-medium">类别</th>
              <th className="px-3 py-2 text-right font-medium">Credit</th>
              <th className="px-3 py-2 font-medium">说明</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id} className="border-t border-[var(--surface-border)]">
                <td className="whitespace-nowrap px-3 py-2 tabular-nums text-[var(--text-soft)]">
                  {formatTime(entry.createdAt)}
                </td>
                <td className="px-3 py-2">
                  <button
                    type="button"
                    onClick={() => filterUser(entry.username)}
                    className="text-[var(--accent)] hover:underline"
                    aria-label={`只看 @${entry.username}`}
                  >
                    @{entry.username}
                  </button>
                </td>
                <td className="whitespace-nowrap px-3 py-2">{ledgerGroupLabel(entry.group)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  <Signed credits={entry.amountCredits} />
                </td>
                <td className="max-w-[240px] truncate px-3 py-2 text-[var(--text-faint)]">
                  {entry.detail ?? entry.kind}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && entries.length === 0 && !error ? (
          <p role="status" className="p-6 text-center text-xs text-[var(--text-faint)]">
            没有记录
          </p>
        ) : null}
      </div>
      {loading ? (
        <p role="status" className="text-center text-xs text-[var(--text-faint)]">
          加载中…
        </p>
      ) : null}
      {!loading && nextCursor !== null ? (
        <Button variant="secondary" className="w-full" onClick={() => void more()}>
          加载更多
        </Button>
      ) : null}
    </>
  );
}
