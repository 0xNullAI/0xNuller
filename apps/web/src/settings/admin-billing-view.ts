import type { AdminLedgerFilter, LedgerGroup, LedgerTotal } from '@0xnullai/auth';

/** Display rules for the admin billing view; kept free of React so they stay unit-testable. */

export const LEDGER_GROUPS: readonly (readonly [LedgerGroup, string])[] = [
  ['redeem', '卡密兑换'],
  ['purchase', '旧充值'],
  ['gift', '赠送'],
  ['reward', '奖励'],
  ['tip', '打赏'],
  ['usage', '消费'],
  ['refund', '退款'],
  ['adjust', '调整'],
];

export function ledgerGroupLabel(group: LedgerGroup | string): string {
  return LEDGER_GROUPS.find(([id]) => id === group)?.[1] ?? group;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Ledger days are China calendar days (UTC+8, no daylight saving), matching the server. */
const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;

export function chinaDayStart(at: number): number {
  return Math.floor((at + CHINA_OFFSET_MS) / DAY_MS) * DAY_MS - CHINA_OFFSET_MS;
}

export function chinaDate(at: number): string {
  return new Date(chinaDayStart(at) + CHINA_OFFSET_MS).toISOString().slice(0, 10);
}

/** Start of a China calendar day given as YYYY-MM-DD; null when malformed. */
export function chinaDateStart(date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(at) ? at - CHINA_OFFSET_MS : null;
}

export type RangePreset = 'today' | '7d' | '30d' | 'custom';

export const RANGE_PRESETS: readonly (readonly [RangePreset, string])[] = [
  ['today', '今天'],
  ['7d', '7天'],
  ['30d', '30天'],
  ['custom', '自定义'],
];

/** Inclusive start, exclusive end. A custom range covers whole days, both ends included. */
export function ledgerRange(
  preset: RangePreset,
  now: number,
  custom: { from: string; to: string } = { from: '', to: '' },
): { from?: number; to?: number } {
  const today = chinaDayStart(now);
  if (preset === 'today') return { from: today, to: today + DAY_MS };
  if (preset === '7d') return { from: today - 6 * DAY_MS, to: today + DAY_MS };
  if (preset === '30d') return { from: today - 29 * DAY_MS, to: today + DAY_MS };
  const from = chinaDateStart(custom.from);
  const end = chinaDateStart(custom.to);
  return {
    ...(from === null ? {} : { from }),
    ...(end === null ? {} : { to: end + DAY_MS }),
  };
}

export function ledgerFilter(input: {
  username: string;
  group: LedgerGroup | '';
  range: { from?: number; to?: number };
}): AdminLedgerFilter {
  const username = input.username.trim().replace(/^@+/, '');
  return {
    ...(username ? { username } : {}),
    ...(input.group ? { group: input.group } : {}),
    ...input.range,
  };
}

const NUMBER = new Intl.NumberFormat('zh-CN');

export function formatCredits(credits: number): string {
  return NUMBER.format(credits);
}

export function formatSignedCredits(credits: number): string {
  return credits > 0 ? `+${NUMBER.format(credits)}` : NUMBER.format(credits);
}

export function creditTone(credits: number): 'in' | 'out' | 'none' {
  return credits > 0 ? 'in' : credits < 0 ? 'out' : 'none';
}

/** The four headline numbers: money in (new keys plus legacy purchases), gifts, usage, refunds. */
export function headlineTotals(groups: Partial<Record<LedgerGroup, LedgerTotal>>) {
  const credits = (group: LedgerGroup) => groups[group]?.credits ?? 0;
  return {
    income: credits('redeem') + credits('purchase'),
    gift: credits('gift'),
    usage: credits('usage'),
    refund: credits('refund'),
  };
}

function csvCell(value: string | number): string {
  let text = String(value);
  // A spreadsheet would run a note starting with these as a formula.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function redeemCodesCsv(input: {
  codes: readonly string[];
  amountCny: number;
  credits: number;
  batchId: string;
  note: string;
}): string {
  const rows = [
    ['key', 'amount_cny', 'credits', 'batch_id', 'note'],
    ...input.codes.map((code) => [code, input.amountCny, input.credits, input.batchId, input.note]),
  ];
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function formatTime(at: number): string {
  return new Date(at).toLocaleString('zh-CN', { hour12: false });
}
