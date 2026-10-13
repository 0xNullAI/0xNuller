import { describe, expect, it } from 'vitest';
import worker, { creditBalance } from './index';
import { env, prepared, req, seedUser, useAuthWorkerTestEnv } from './index.test-support';
import { createTestDb } from './test-helpers';
import { MAX_REDEEM_FAILURES_PER_ACCOUNT } from './redeem-codes';

useAuthWorkerTestEnv(createTestDb);

type Account = { id: string; token: string };

async function account(username: string, admin = false): Promise<Account> {
  // Seeded rather than registered: registration is rate-limited per IP.
  const { id, token } = await seedUser(username);
  const body = { user: { id }, token };
  if (admin) await prepared("UPDATE users SET role = 'admin' WHERE id = ?", body.user!.id).run();
  return { id: body.user!.id, token: body.token! };
}

function call(who: Account, path: string, body?: unknown, ip?: string) {
  return worker.fetch(
    req(path, {
      method: body === undefined ? 'GET' : 'POST',
      token: who.token,
      ip,
      headers: { 'X-Account-Id': who.id },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
  );
}

async function mint(admin: Account, amountCny = 6, count = 2) {
  const response = await call(admin, '/api/auth/admin/redeem-codes', { amountCny, count });
  expect(response.status).toBe(201);
  return (await response.json()) as { batch: { id: string }; codes: string[] };
}

describe('卡密兑换', () => {
  it('管理员按固定档位生成卡密，明文只返回一次，库里只有哈希', async () => {
    const admin = await account('admin', true);
    const { batch, codes } = await mint(admin, 30, 3);

    expect(codes).toHaveLength(3);
    for (const code of codes) expect(code).toMatch(/^[2-9A-HJ-NP-Z]{64}$/);
    expect(new Set(codes).size).toBe(3);
    const stored = await prepared(
      'SELECT code_hash, code_tail, amount_credits FROM redeem_codes WHERE batch_id = ?',
      batch.id,
    ).all<{ code_hash: string; code_tail: string; amount_credits: number }>();
    expect(stored.results).toHaveLength(3);
    for (const row of stored.results) {
      expect(codes).not.toContain(row.code_hash);
      expect(row.amount_credits).toBe(5_000);
    }
    expect(stored.results.map((row) => row.code_tail).sort()).toEqual(
      codes.map((code) => code.slice(-4)).sort(),
    );
  });

  it('只有管理员能生成，且只接受固定档位和合理数量', async () => {
    const admin = await account('admin', true);
    const user = await account('buyer');
    expect(
      (await call(user, '/api/auth/admin/redeem-codes', { amountCny: 6, count: 1 })).status,
    ).toBe(403);
    expect(
      (await call(admin, '/api/auth/admin/redeem-codes', { amountCny: 7, count: 1 })).status,
    ).toBe(400);
    expect(
      (await call(admin, '/api/auth/admin/redeem-codes', { amountCny: 6, count: 101 })).status,
    ).toBe(400);
  });

  it('兑换后到账一次，同一张卡不能再用，换个账号也不行', async () => {
    const admin = await account('admin', true);
    const buyer = await account('buyer');
    const other = await account('other');
    const { codes } = await mint(admin, 6, 1);
    // Users may paste it with spaces, dashes or in lower case.
    const typed = codes[0]!.toLowerCase().replace(/(.{8})/g, '$1-');

    const redeemed = await call(buyer, '/api/auth/credits/redeem', { code: typed });
    expect(redeemed.status).toBe(201);
    expect(await redeemed.json()).toMatchObject({ amountCredits: 1_000 });
    expect((await creditBalance(env, buyer.id)).total).toBe(1_000);

    expect((await call(buyer, '/api/auth/credits/redeem', { code: codes[0] })).status).toBe(409);
    expect((await call(other, '/api/auth/credits/redeem', { code: codes[0] })).status).toBe(409);
    expect((await creditBalance(env, other.id)).total).toBe(0);
    const ledger = await prepared(
      "SELECT kind, reference_id FROM credit_ledger WHERE user_id = ? AND kind = 'manual_purchase'",
      buyer.id,
    ).all<{ kind: string; reference_id: string }>();
    expect(ledger.results).toEqual([
      { kind: 'manual_purchase', reference_id: expect.stringMatching(/^redeem:rc_/) },
    ]);
  });

  it('同一张卡并发兑换只成功一次', async () => {
    const admin = await account('admin', true);
    const a = await account('alice2');
    const b = await account('bob2');
    const { codes } = await mint(admin, 68, 1);

    const results = await Promise.all([
      call(a, '/api/auth/credits/redeem', { code: codes[0] }),
      call(b, '/api/auth/credits/redeem', { code: codes[0] }),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([201, 409]);
    const total = (await creditBalance(env, a.id)).total + (await creditBalance(env, b.id)).total;
    expect(total).toBe(12_000);
  });

  it('连续输错会被暂时禁止，正确的卡密也要等锁解除', async () => {
    const admin = await account('admin', true);
    const buyer = await account('buyer');
    const { codes } = await mint(admin, 6, 1);
    const wrong = '2'.repeat(64);

    for (let attempt = 0; attempt < MAX_REDEEM_FAILURES_PER_ACCOUNT; attempt += 1) {
      expect((await call(buyer, '/api/auth/credits/redeem', { code: wrong })).status).toBe(400);
    }
    expect((await call(buyer, '/api/auth/credits/redeem', { code: codes[0] })).status).toBe(429);
    expect((await creditBalance(env, buyer.id)).total).toBe(0);

    // The lock lifts as the failures age out of the window.
    await prepared('UPDATE redeem_attempts SET created_at = created_at - ?', 31 * 60 * 1000).run();
    expect((await call(buyer, '/api/auth/credits/redeem', { code: codes[0] })).status).toBe(201);
  });

  it('同一 IP 下换账号试码也会被锁', async () => {
    await account('admin', true);
    const wrong = '3'.repeat(64);
    let locked = false;
    for (let index = 0; index < 5 && !locked; index += 1) {
      const user = await account(`prober${index}`);
      for (let attempt = 0; attempt < MAX_REDEEM_FAILURES_PER_ACCOUNT; attempt += 1) {
        const status = (await call(user, '/api/auth/credits/redeem', { code: wrong }, '9.9.9.9'))
          .status;
        if (status === 429) locked = true;
      }
    }
    expect(locked).toBe(true);
  });

  it('管理员能看到批次的使用情况和兑换记录，但看不到明文', async () => {
    const admin = await account('admin', true);
    const buyer = await account('buyer');
    const { batch, codes } = await mint(admin, 6, 2);
    await call(buyer, '/api/auth/credits/redeem', { code: codes[1] });

    const batches = (await (await call(admin, '/api/auth/admin/redeem-codes/batches')).json()) as {
      batches: { id: string; count: number; redeemed: number }[];
    };
    expect(batches.batches[0]).toMatchObject({ id: batch.id, count: 2, redeemed: 1 });

    const detail = await (
      await call(admin, `/api/auth/admin/redeem-codes/batches/${batch.id}`)
    ).text();
    for (const code of codes) expect(detail).not.toContain(code);
    expect(detail).toContain(codes[1]!.slice(-4));
    expect(detail).toContain('buyer');

    const redemptions = (await (
      await call(admin, '/api/auth/admin/redeem-codes/redemptions')
    ).json()) as { redemptions: { redeemedBy: string; amountCredits: number }[] };
    expect(redemptions.redemptions).toEqual([
      expect.objectContaining({ redeemedBy: 'buyer', amountCredits: 1_000 }),
    ]);
    expect((await call(buyer, '/api/auth/admin/redeem-codes/batches')).status).toBe(403);
  });
});
