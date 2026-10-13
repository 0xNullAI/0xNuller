import { err, json } from './http';
import { currentUser, type SessionEnv } from './session-domain';

/**
 * The admin billing view: every ledger row across accounts, grouped by what it means rather than
 * by its storage kind, plus per-day totals. Read-only; balances still come from the ledger sum.
 */

const PATH = '/api/auth/admin/ledger';
const PAGE = 50;
/** Days are counted in China time, where the users and the operator are. */
const DAY_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SUMMARY_DAYS = 92;

export const LEDGER_GROUPS = [
  'redeem',
  'purchase',
  'gift',
  'reward',
  'tip',
  'usage',
  'refund',
  'adjust',
] as const;
export type LedgerGroup = (typeof LEDGER_GROUPS)[number];

/** One storage kind can mean two things (a redeem key or an old manual top-up; a gift or the welcome grant). */
const GROUP_SQL = `CASE
  WHEN l.kind = 'manual_purchase' AND l.reference_id LIKE 'redeem:%' THEN 'redeem'
  WHEN l.kind = 'manual_purchase' THEN 'purchase'
  WHEN l.kind = 'admin_gift' AND l.reference_id = 'welcome' THEN 'reward'
  WHEN l.kind IN ('admin_gift', 'red_packet') THEN 'gift'
  WHEN l.kind IN ('referral_reward', 'market_download_reward') THEN 'reward'
  WHEN l.kind = 'market_tip' THEN 'tip'
  WHEN l.kind = 'usage' THEN 'usage'
  WHEN l.kind = 'refund' THEN 'refund'
  ELSE 'adjust' END`;

export async function handleAdminLedger(
  request: Request,
  env: SessionEnv,
  cors: Record<string, string>,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== PATH && url.pathname !== `${PATH}/summary`) return null;
  const headers = { ...cors, 'Cache-Control': 'no-store' };
  const user = await currentUser(request, env);
  if (!user || user.role !== 'admin') return err('无管理权限', 403, headers);
  if (user.banned_at !== null || request.headers.get('X-Account-Id') !== user.id)
    return err('账号不可用或已切换', 403, headers);
  if (request.method !== 'GET') return err('不支持此操作', 405, headers);

  const filter = parseFilter(url);
  if (typeof filter === 'string') return err(filter, 400, headers);
  return url.pathname === PATH
    ? listEntries(env, filter, headers)
    : summarize(env, filter, headers);
}

interface Filter {
  username: string | null;
  group: LedgerGroup | null;
  from: number | null;
  to: number | null;
  before: number | null;
}

function parseFilter(url: URL): Filter | string {
  const time = (name: string): number | null | undefined => {
    const raw = url.searchParams.get(name);
    if (raw === null || raw === '') return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  };
  const from = time('from');
  const to = time('to');
  const before = time('before');
  if (from === undefined || to === undefined || before === undefined) return '时间或游标无效';
  const groupParam = url.searchParams.get('group');
  const group =
    groupParam && (LEDGER_GROUPS as readonly string[]).includes(groupParam)
      ? (groupParam as LedgerGroup)
      : null;
  if (groupParam && !group) return '类型无效';
  const username =
    url.searchParams.get('username')?.trim().replace(/^@+/, '').toLowerCase() || null;
  return { username, group, from, to, before };
}

function where(filter: Filter, withCursor: boolean): { sql: string; args: unknown[] } {
  const clauses: string[] = [];
  const args: unknown[] = [];
  if (filter.username) {
    clauses.push('u.username = ?');
    args.push(filter.username);
  }
  if (filter.group) {
    clauses.push(`(${GROUP_SQL}) = ?`);
    args.push(filter.group);
  }
  if (filter.from !== null) {
    clauses.push('l.created_at >= ?');
    args.push(filter.from);
  }
  if (filter.to !== null) {
    clauses.push('l.created_at < ?');
    args.push(filter.to);
  }
  if (withCursor && filter.before !== null) {
    clauses.push('l.id < ?');
    args.push(filter.before);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', args };
}

async function listEntries(
  env: SessionEnv,
  filter: Filter,
  headers: Record<string, string>,
): Promise<Response> {
  const { sql, args } = where(filter, true);
  const rows = await env.DB.prepare(
    `SELECT l.id, l.kind, l.amount_credits, l.reference_id, l.metadata_json, l.created_at,
            u.username, (${GROUP_SQL}) AS grp, r.usage_kind, r.model_id
       FROM credit_ledger l
       JOIN users u ON u.id = l.user_id
       LEFT JOIN credit_reservations r
         ON l.kind = 'usage' AND r.user_id = l.user_id AND r.idempotency_key = l.reference_id
      ${sql}
      ORDER BY l.id DESC LIMIT ${PAGE + 1}`,
  )
    .bind(...args)
    .all<Record<string, unknown>>();
  const page = rows.results.slice(0, PAGE);
  return json(
    {
      entries: page.map((row) => ({
        id: Number(row.id),
        username: String(row.username),
        group: String(row.grp),
        kind: String(row.kind),
        amountCredits: Number(row.amount_credits),
        referenceId: String(row.reference_id),
        detail: describe(row),
        createdAt: Number(row.created_at),
      })),
      nextCursor: rows.results.length > PAGE ? Number(page.at(-1)!.id) : null,
    },
    200,
    headers,
  );
}

async function summarize(
  env: SessionEnv,
  filter: Filter,
  headers: Record<string, string>,
): Promise<Response> {
  const to = filter.to ?? Date.now();
  const from = filter.from ?? to - 30 * DAY_MS;
  if (to <= from || to - from > MAX_SUMMARY_DAYS * DAY_MS)
    return err(`汇总范围最长 ${MAX_SUMMARY_DAYS} 天`, 400, headers);
  const { sql, args } = where({ ...filter, from, to, before: null }, false);
  const rows = await env.DB.prepare(
    `SELECT CAST((l.created_at + ${DAY_OFFSET_MS}) / ${DAY_MS} AS INTEGER) AS day,
            (${GROUP_SQL}) AS grp,
            COUNT(*) AS entries,
            COALESCE(SUM(l.amount_credits), 0) AS credits
       FROM credit_ledger l JOIN users u ON u.id = l.user_id
      ${sql}
      GROUP BY day, grp ORDER BY day DESC`,
  )
    .bind(...args)
    .all<{ day: number; grp: string; entries: number; credits: number }>();
  const days = new Map<
    number,
    { date: string; groups: Record<string, { entries: number; credits: number }> }
  >();
  const totals: Record<string, { entries: number; credits: number }> = {};
  for (const row of rows.results) {
    const day = Number(row.day);
    const entry = days.get(day) ?? { date: chinaDate(day), groups: {} };
    entry.groups[row.grp] = { entries: Number(row.entries), credits: Number(row.credits) };
    days.set(day, entry);
    const total = (totals[row.grp] ??= { entries: 0, credits: 0 });
    total.entries += Number(row.entries);
    total.credits += Number(row.credits);
  }
  return json({ from, to, days: [...days.values()], totals }, 200, headers);
}

function chinaDate(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** A short human label for one row; never the raw metadata. */
function describe(row: Record<string, unknown>): string | null {
  if (typeof row.model_id === 'string') return row.model_id.slice(0, 120);
  let metadata: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(String(row.metadata_json ?? '{}'));
    if (value && typeof value === 'object' && !Array.isArray(value))
      metadata = value as Record<string, unknown>;
  } catch {
    return null;
  }
  for (const key of ['reason', 'note', 'model']) {
    const value = metadata[key];
    if (typeof value === 'string' && value) return value.slice(0, 120);
  }
  return null;
}
