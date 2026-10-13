import { useEffect, useState } from 'react';
import {
  getAdminLedgerSummary,
  getAdminStats,
  listAdminCreditRedPackets,
  type AdminLedgerSummary,
  type AdminStats,
} from '@0xnullai/auth';
import { AdminCard, errorText } from './AdminCard';
import {
  chinaDate,
  creditTone,
  formatCredits,
  formatSignedCredits,
  headlineTotals,
  ledgerRange,
} from './admin-billing-view';

const HEADLINES = [
  ['income', '入账'],
  ['gift', '赠送'],
  ['usage', '消耗'],
  ['refund', '退款'],
] as const;

function Tile({ label, value, tone }: { label: string; value: string; tone?: 'in' | 'out' }) {
  return (
    <div className="min-w-0 rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--bg-soft)] p-3">
      <div className="truncate text-xs text-[var(--text-faint)]">{label}</div>
      <div
        className={`mt-1 truncate text-lg font-semibold tabular-nums ${
          tone === 'in' ? 'text-[var(--success)]' : tone === 'out' ? 'text-[var(--danger)]' : ''
        }`}
      >
        {value}
      </div>
    </div>
  );
}

export function AdminOverview() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [summary, setSummary] = useState<{ value: AdminLedgerSummary; today: string } | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [pendingPackets, setPendingPackets] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    void getAdminStats()
      .then((value) => active && setStats(value))
      .catch(() => undefined);
    const now = Date.now();
    void getAdminLedgerSummary(ledgerRange('7d', now))
      .then((value) => active && setSummary({ value, today: chinaDate(now) }))
      .catch((cause: unknown) => active && setSummaryError(errorText(cause, '汇总加载失败')));
    void listAdminCreditRedPackets()
      .then(
        (result) =>
          active &&
          setPendingPackets(result.items.filter((item) => item.status === 'pending').length),
      )
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const today = summary?.value.days.find((day) => day.date === summary.today);
  const periods = summary
    ? ([
        ['今天', headlineTotals(today?.groups ?? {})],
        ['近 7 天', headlineTotals(summary.value.totals)],
      ] as const)
    : [];

  return (
    <>
      <AdminCard title="Credit 流水">
        {summaryError ? (
          <p role="alert" className="text-xs text-[var(--danger)]">
            {summaryError}
          </p>
        ) : null}
        {!summary && !summaryError ? (
          <p className="text-xs text-[var(--text-faint)]">加载中…</p>
        ) : null}
        <div className="flex flex-col gap-3">
          {periods.map(([label, totals]) => (
            <div key={label} aria-label={label} role="group">
              <div className="mb-1.5 text-xs font-medium text-[var(--text-soft)]">{label}</div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {HEADLINES.map(([key, text]) => {
                  const value = totals[key];
                  const tone = creditTone(value);
                  return (
                    <Tile
                      key={key}
                      label={text}
                      value={formatSignedCredits(value)}
                      tone={tone === 'none' ? undefined : tone}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </AdminCard>
      <AdminCard title="待处理">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Tile label="用户举报" value={stats ? String(stats.openReports) : '—'} />
          <Tile label="口令红包" value={pendingPackets === null ? '—' : String(pendingPackets)} />
        </div>
      </AdminCard>
      {stats ? (
        <AdminCard title="账户与用量">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {(
              [
                ['账户', stats.users],
                ['已验证', stats.verifiedUsers],
                ['活跃会话', stats.activeSessions],
                ['24h 注册尝试', stats.registrationAttempts24h],
                ['今日消费 Credit', stats.creditUsedToday],
                ['今日充值 Credit', stats.creditPurchasedToday],
              ] as const
            ).map(([label, value]) => (
              <Tile key={label} label={label} value={formatCredits(value)} />
            ))}
          </div>
        </AdminCard>
      ) : null}
    </>
  );
}
