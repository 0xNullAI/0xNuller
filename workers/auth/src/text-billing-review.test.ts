import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDb } from './test-helpers';
import { sha256Hex, type SessionEnv } from './session-domain';
import { handleTextBillingReview } from './text-billing-review';
let db: ReturnType<typeof createTestDb>;
let env: SessionEnv;
const key = 'text:review:001';
beforeEach(async () => {
  db = createTestDb();
  env = { DB: db.DB } as SessionEnv;
  for (const id of ['alice', 'admin']) {
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
  await env.DB.prepare(
    "INSERT INTO credit_reservations(idempotency_key,user_id,usage_kind,model_id,reserved_credits,status,created_at,updated_at) VALUES(?,'alice','agent','balanced',20,'released',1,1)",
  )
    .bind(key)
    .run();
  await env.DB.prepare(
    "INSERT INTO text_billing_outbox(reservation_key,capability,state,reason,updated_at) VALUES(?,'SECRET-CAPABILITY','needs_review','interrupted_without_usage',1)",
  )
    .bind(key)
    .run();
});
afterEach(() => db.close());
async function call(body?: unknown, user = 'admin', account = user) {
  return (await handleTextBillingReview(
    new Request(`https://test/api/auth/admin/billing/text-reconciliation${body ? '/notes' : ''}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${user}`, 'X-Account-Id': account },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    {},
  ))!;
}
interface ReviewPage {
  items: Array<{ id: string; notes: Array<{ operatorId: string; note: string }> }>;
  nextCursor: number | null;
}
const page = async (response: Response) => (await response.json()) as ReviewPage;
const note = {
  eventId: 'event:review:001',
  id: key,
  note: '已查日志，用量缺失，不能确认费用。',
  observed: { state: 'needs_review', status: 'released', updatedAt: 1, confirmedCharge: null },
};
it('requires an active administrator and pinned account on reads and notes', async () => {
  expect((await call(undefined, 'alice')).status).toBe(403);
  expect((await call(note, 'alice')).status).toBe(403);
  expect((await call(undefined, 'admin', 'alice')).status).toBe(403);
  expect((await call(undefined, 'unknown')).status).toBe(401);
  await env.DB.prepare("UPDATE users SET banned_at=1 WHERE id='admin'").run();
  expect((await call(note)).status).toBe(403);
});
it('returns a private projection with no capability or raw metadata', async () => {
  const response = await call();
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const body = await response.text();
  expect(body).not.toContain('SECRET-CAPABILITY');
  expect(body).not.toContain('metadata_json');
  expect(JSON.parse(body).items[0]).toMatchObject({
    id: key,
    state: 'needs_review',
    confirmedCharge: null,
    notes: [],
  });
});
it('records immutable idempotent notes without changing wallet state, and rejects conflicting replay', async () => {
  expect((await call(note)).status).toBe(200);
  expect((await call(note)).status).toBe(200);
  expect((await call({ ...note, note: '不同备注' })).status).toBe(409);
  expect((await env.DB.prepare('SELECT * FROM text_billing_reviews').all()).results).toHaveLength(
    1,
  );
  expect((await env.DB.prepare('SELECT * FROM credit_ledger').all()).results).toEqual([]);
  expect(await env.DB.prepare('SELECT state FROM text_billing_outbox').first()).toEqual({
    state: 'needs_review',
  });
  expect((await page(await call())).items[0]!.notes[0]).toMatchObject({
    operatorId: 'admin',
    note: note.note,
  });
});
it('rejects stale observed state and foreign/missing reservations', async () => {
  expect((await call({ ...note, observed: { ...note.observed, updatedAt: 0 } })).status).toBe(409);
  expect((await call({ ...note, id: 'text:missing:001' })).status).toBe(409);
  expect((await env.DB.prepare('SELECT * FROM text_billing_reviews').all()).results).toEqual([]);
});
it('keeps audit notes visible after automatic recovery and paginates equal timestamps without leaking secrets', async () => {
  expect((await call(note)).status).toBe(200);
  await env.DB.prepare("UPDATE text_billing_outbox SET state='released'").run();
  expect((await page(await call())).items[0]!.notes).toHaveLength(1);
  for (let i = 0; i < 31; i++) {
    const id = `text:page:${String(i).padStart(3, '0')}`;
    await env.DB.prepare(
      "INSERT INTO credit_reservations(idempotency_key,user_id,usage_kind,model_id,reserved_credits,status,created_at,updated_at) VALUES(?,'alice','agent','balanced',20,'pending',1,1)",
    )
      .bind(id)
      .run();
    await env.DB.prepare(
      'INSERT INTO text_billing_outbox(reservation_key,capability,updated_at) VALUES(?,?,1)',
    )
      .bind(id, `secret:${i}`)
      .run();
  }
  const first = await page(await call());
  expect(first.items).toHaveLength(30);
  const second = await handleTextBillingReview(
    new Request(
      `https://test/api/auth/admin/billing/text-reconciliation?before=${first.nextCursor}`,
      { headers: { Authorization: 'Bearer admin', 'X-Account-Id': 'admin' } },
    ),
    env,
    {},
  );
  const next = await page(second!);
  expect(next.items).toHaveLength(2);
  expect(new Set([...first.items, ...next.items].map((i) => i.id)).size).toBe(32);
});
