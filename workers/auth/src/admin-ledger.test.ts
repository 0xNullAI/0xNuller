import { describe, expect, it } from 'vitest';
import worker from './index';
import { env, prepared, req, seedUser, useAuthWorkerTestEnv } from './index.test-support';
import { createTestDb } from './test-helpers';

useAuthWorkerTestEnv(createTestDb);

const DAY = 24 * 60 * 60 * 1000;
// 2026-10-13 12:00 China time.
const NOON = Date.UTC(2026, 9, 13, 4);

async function ledger(
  userId: string,
  kind: string,
  credits: number,
  reference: string,
  at: number,
) {
  await prepared(
    `INSERT INTO credit_ledger (user_id, amount_credits, kind, reference_id, price_version, metadata_json, created_at)
     VALUES (?, ?, ?, ?, 'v', '{}', ?)`,
    userId,
    credits,
    kind,
    reference,
    at,
  ).run();
}

async function setup() {
  const admin = await seedUser('admin');
  await prepared("UPDATE users SET role = 'admin' WHERE id = ?", admin.id).run();
  const buyer = await seedUser('buyer');
  const other = await seedUser('other');
  await ledger(buyer.id, 'manual_purchase', 1_000, 'redeem:rc_1', NOON);
  await ledger(buyer.id, 'manual_purchase', 5_000, 'alipay:old', NOON - DAY);
  await ledger(buyer.id, 'admin_gift', 100, 'welcome', NOON - DAY);
  await ledger(other.id, 'admin_gift', 888, 'gift:1', NOON);
  await ledger(buyer.id, 'usage', -40, 'turn-1', NOON + 60_000);
  await ledger(other.id, 'support_adjustment', -5, 'fix-1', NOON);
  return { admin, buyer };
}

function get(who: { id: string; token: string }, path: string) {
  return worker.fetch(req(path, { token: who.token, headers: { 'X-Account-Id': who.id } }), env);
}

describe('管理员账单视图', () => {
  it('按含义分组列出所有账号的流水，并可按用户和类型筛选', async () => {
    const { admin } = await setup();
    const all = (await (await get(admin, '/api/auth/admin/ledger')).json()) as {
      entries: { username: string; group: string; amountCredits: number }[];
    };
    expect(all.entries.map((entry) => entry.group).sort()).toEqual(
      ['adjust', 'gift', 'purchase', 'redeem', 'reward', 'usage'].sort(),
    );

    const redeem = (await (
      await get(admin, '/api/auth/admin/ledger?group=redeem&username=@Buyer')
    ).json()) as { entries: { amountCredits: number }[] };
    expect(redeem.entries).toEqual([expect.objectContaining({ amountCredits: 1_000 })]);
    expect((await get(admin, '/api/auth/admin/ledger?group=nope')).status).toBe(400);
  });

  it('按中国时间的自然日汇总', async () => {
    const { admin } = await setup();
    const response = await get(
      admin,
      `/api/auth/admin/ledger/summary?from=${NOON - 3 * DAY}&to=${NOON + DAY}`,
    );
    const summary = (await response.json()) as {
      days: { date: string; groups: Record<string, { credits: number }> }[];
      totals: Record<string, { credits: number; entries: number }>;
    };
    expect(summary.days.map((day) => day.date)).toEqual(['2026-10-13', '2026-10-12']);
    expect(summary.days[0]!.groups.redeem).toEqual({ entries: 1, credits: 1_000 });
    expect(summary.days[0]!.groups.usage!.credits).toBe(-40);
    expect(summary.totals.purchase).toEqual({ entries: 1, credits: 5_000 });
    expect(summary.totals.reward).toEqual({ entries: 1, credits: 100 });
    expect((await get(admin, `/api/auth/admin/ledger/summary?from=0&to=${NOON}`)).status).toBe(400);
  });

  it('只有管理员能看', async () => {
    const { buyer } = await setup();
    expect((await get(buyer, '/api/auth/admin/ledger')).status).toBe(403);
    expect((await get(buyer, '/api/auth/admin/ledger/summary')).status).toBe(403);
  });
});
