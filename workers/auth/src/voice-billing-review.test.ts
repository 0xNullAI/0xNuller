import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDb } from './test-helpers';
import { sha256Hex, type SessionEnv } from './session-domain';
import { handleVoiceBillingReview } from './voice-billing-review';
let db: ReturnType<typeof createTestDb>;
let env: SessionEnv;
const key = 'voice:review:001';
async function seed(id: string, user = 'alice', time = 100) {
  await env.DB.prepare(
    "INSERT INTO credit_reservations(idempotency_key,user_id,usage_kind,model_id,reserved_credits,status,created_at,updated_at) VALUES(?,?,'voice','voice',80,'released',1,200)",
  )
    .bind(id, user)
    .run();
  await env.DB.prepare(
    "INSERT INTO voice_billing_reviews VALUES(?,?,'reservation_expired','settle',40000,80,80,'price-v1',1,?)",
  )
    .bind(id, user, time)
    .run();
}
beforeEach(async () => {
  db = createTestDb();
  env = { DB: db.DB } as SessionEnv;
  for (const id of ['alice', 'bob', 'admin']) {
    await env.DB.prepare(
      'INSERT INTO users(id,username,display_name,password_hash,created_at,role) VALUES(?,?,?,?,1,?)',
    )
      .bind(id, id, id, 'unused', id === 'admin' ? 'admin' : 'user')
      .run();
    await env.DB.prepare(
      'INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,1,?)',
    )
      .bind(await sha256Hex(id), id, Date.now() + 86400000)
      .run();
  }
  await seed(key);
});
afterEach(() => db.close());
async function call(body?: unknown, query = '', user = 'admin', account = user) {
  return (await handleVoiceBillingReview(
    new Request(
      `https://test/api/auth/admin/billing/voice-reconciliation${body ? '/notes' : ''}${query}`,
      {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${user}`, 'X-Account-Id': account },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    ),
    env,
    {},
  ))!;
}
const note = {
  eventId: 'review:event:001',
  id: key,
  accountId: 'alice',
  note: '已核对冻结过期，暂无追扣依据。',
  observed: { status: 'released', updatedAt: 200, charged: null },
};
interface Page {
  items: Array<{ id: string; accountId: string; notes: unknown[] }>;
  nextCursor: number | null;
}
const page = async (query = '') => (await (await call(undefined, query)).json()) as Page;
it('requires live admin and pinned account for both reads and writes', async () => {
  expect((await call(undefined, '', 'alice')).status).toBe(403);
  expect((await call(note, '', 'alice')).status).toBe(403);
  expect((await call(undefined, '', 'admin', 'alice')).status).toBe(403);
  expect((await call(undefined, '', 'missing')).status).toBe(401);
  await env.DB.prepare("UPDATE users SET banned_at=1 WHERE id='admin'").run();
  expect((await call(note)).status).toBe(403);
});
it('filters exact owner and inclusive time without exposing unrelated records; never caches', async () => {
  await seed('voice:bob:001', 'bob', 150);
  await seed('voice:alice:002', 'alice', 160);
  const response = await call(undefined, '?accountId=alice&from=100&to=150');
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const body = (await response.json()) as Page;
  expect(body.items.map((x) => x.id)).toEqual([key]);
  expect((await page('?accountId=bob')).items.map((x) => x.id)).toEqual(['voice:bob:001']);
  for (const query of ['?from=no', '?from=20&to=10', '?before=-1', '?accountId='])
    expect((await call(undefined, query)).status).toBe(400);
});
it('appends immutable idempotent notes concurrently without changing financial state', async () => {
  expect((await Promise.all([call(note), call(note)])).map((x) => x.status)).toEqual([200, 200]);
  expect((await call({ ...note, note: '改变的核对备注' })).status).toBe(409);
  expect(
    (await env.DB.prepare('SELECT * FROM voice_billing_review_notes').all()).results,
  ).toHaveLength(1);
  expect((await env.DB.prepare('SELECT * FROM credit_ledger').all()).results).toEqual([]);
  expect(
    await env.DB.prepare('SELECT status,charged_credits FROM credit_reservations').first(),
  ).toEqual({ status: 'released', charged_credits: null });
  expect((await page()).items[0]!.notes).toHaveLength(1);
  expect(
    (await call({ ...note, eventId: 'review:event:002', note: '再次核对，继续保留异常。' })).status,
  ).toBe(200);
  expect((await page()).items[0]!.notes).toHaveLength(2);
});
it('rejects wrong target account, missing record and stale observed status', async () => {
  expect((await call({ ...note, accountId: 'bob' })).status).toBe(409);
  expect((await call({ ...note, id: 'voice:missing:001' })).status).toBe(409);
  expect((await call({ ...note, observed: { ...note.observed, updatedAt: 1 } })).status).toBe(409);
  expect((await env.DB.prepare('SELECT * FROM voice_billing_review_notes').all()).results).toEqual(
    [],
  );
});
it('paginates identical timestamps without duplication and retains the account filter', async () => {
  for (let i = 0; i < 31; i++) await seed(`voice:page:${String(i).padStart(3, '0')}`);
  await seed('voice:bob:001', 'bob');
  const first = await page('?accountId=alice');
  const second = await page(`?accountId=alice&before=${first.nextCursor}`);
  expect(first.items).toHaveLength(30);
  expect(second.items).toHaveLength(2);
  expect(new Set([...first.items, ...second.items].map((x) => x.id)).size).toBe(32);
  expect([...first.items, ...second.items].every((x) => x.accountId === 'alice')).toBe(true);
});
it('lists usage-billed calls whose rounds lacked usage alongside the expiry reviews', async () => {
  await env.DB.prepare(
    "INSERT INTO credit_reservations(idempotency_key,user_id,usage_kind,model_id,reserved_credits,status,charged_credits,created_at,updated_at) VALUES('voice:usage:001','bob','voice','voice',80,'settled',20,1,300)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO voice_usage_reviews VALUES('voice:usage:001','bob','usage_missing',1,2,30000,'{}',20,20,80,'realtime:v1',300)",
  ).run();
  const all = (await (await call()).json()) as { usageItems: Array<Record<string, unknown>> };
  expect(all.usageItems).toEqual([
    expect.objectContaining({
      id: 'voice:usage:001',
      accountId: 'bob',
      reason: 'usage_missing',
      missingRounds: 2,
      chargedCredits: 20,
      status: 'settled',
    }),
  ]);
  const filtered = (await (await call(undefined, '?accountId=alice')).json()) as {
    usageItems: unknown[];
  };
  expect(filtered.usageItems).toEqual([]);
});
