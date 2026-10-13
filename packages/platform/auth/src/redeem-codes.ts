import { apiBaseUrl } from '@0xnullai/settings';
import { authRequestHeaders, currentAuthUserId } from './index';

/** Client for redeem keys and the admin billing view (workers/auth redeem-codes.ts, admin-ledger.ts). */

export interface RedeemBatch {
  id: string;
  amountCny: number;
  amountCredits: number;
  count: number;
  redeemed: number;
  note: string;
  operator: string | null;
  createdAt: number;
}

export interface RedeemBatchCode {
  id: string;
  /** The key's last four characters; the server never returns a whole key after minting. */
  tail: string;
  redeemedBy: string | null;
  redeemedAt: number | null;
}

export interface RedeemRecord {
  id: string;
  tail: string;
  amountCny: number;
  amountCredits: number;
  note: string;
  redeemedBy: string | null;
  redeemedAt: number;
}

export type LedgerGroup =
  'redeem' | 'purchase' | 'gift' | 'reward' | 'tip' | 'usage' | 'refund' | 'adjust';

export interface AdminLedgerEntry {
  id: number;
  username: string;
  group: LedgerGroup;
  kind: string;
  amountCredits: number;
  referenceId: string;
  detail: string | null;
  createdAt: number;
}

export interface AdminLedgerFilter {
  username?: string;
  group?: LedgerGroup;
  /** Inclusive start, ms. */
  from?: number;
  /** Exclusive end, ms. */
  to?: number;
}

export interface AdminLedgerSummary {
  from: number;
  to: number;
  /** Newest first; dates are China-time calendar days (YYYY-MM-DD). */
  days: { date: string; groups: Partial<Record<LedgerGroup, LedgerTotal>> }[];
  totals: Partial<Record<LedgerGroup, LedgerTotal>>;
}

export interface LedgerTotal {
  entries: number;
  credits: number;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const account = currentAuthUserId();
  if (!account) throw new Error('请先登录');
  const response = await fetch(`${apiBaseUrl()}/api/auth/${path}`, {
    ...init,
    credentials: 'include',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...authRequestHeaders(),
      'X-Account-Id': account,
    },
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (currentAuthUserId() !== account) throw new Error('账号已切换，请重试');
  if (!response.ok) throw new Error(body.error ?? '请求失败');
  return body;
}

function query(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/** Redeem a key for the signed-in account. */
export const redeemCreditCode = (code: string) =>
  request<{ ok: true; amountCredits: number; referenceId: string; redeemedAt: number }>(
    'credits/redeem',
    { method: 'POST', body: JSON.stringify({ code }) },
  );

/** Admin: mint a batch. The returned keys are the only time their plaintext exists. */
export const mintRedeemCodes = (input: { amountCny: number; count: number; note?: string }) =>
  request<{ batch: Omit<RedeemBatch, 'redeemed' | 'operator'>; codes: string[] }>(
    'admin/redeem-codes',
    { method: 'POST', body: JSON.stringify(input) },
  );

export const listRedeemBatches = (before?: number) =>
  request<{ batches: RedeemBatch[]; nextCursor: number | null }>(
    `admin/redeem-codes/batches${query({ before })}`,
  );

export const listRedeemBatchCodes = (batchId: string) =>
  request<{ codes: RedeemBatchCode[] }>(
    `admin/redeem-codes/batches/${encodeURIComponent(batchId)}`,
  );

export const listRedemptions = (before?: number) =>
  request<{ redemptions: RedeemRecord[]; nextCursor: number | null }>(
    `admin/redeem-codes/redemptions${query({ before })}`,
  );

export const listAdminLedger = (filter: AdminLedgerFilter = {}, before?: number) =>
  request<{ entries: AdminLedgerEntry[]; nextCursor: number | null }>(
    `admin/ledger${query({ ...filter, before })}`,
  );

export const getAdminLedgerSummary = (filter: AdminLedgerFilter = {}) =>
  request<AdminLedgerSummary>(`admin/ledger/summary${query({ ...filter })}`);
