import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb } from './test-helpers';
import { sha256Hex } from './session-domain';
import { handleMediaBillingReview } from './media-billing-review';

let db: ReturnType<typeof createTestDb>;
let env: Parameters<typeof handleMediaBillingReview>[1];
const now = 1_800_000_000_000;

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  db = createTestDb();
  env = { DB: db.DB } as typeof env;
  for (const [id, role] of [
    ['admin', 'admin'],
    ['alice', 'user'],
  ] as const) {
    await env.DB.prepare(
      'INSERT INTO users(id,username,display_name,password_hash,role,created_at) VALUES (?,?,?,?,?,1)',
    )
      .bind(id, id, id, 'unused', role)
      .run();
    await env.DB.prepare(
      'INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES (?,?,1,?)',
    )
      .bind(await sha256Hex(id), id, now + 86400000)
      .run();
  }
  await env.DB.prepare(
    `INSERT INTO media_jobs(user_id,id,relationship_id,conversation_id,kind,prompt,request_json,credits,price_version,reservation_key,state,object_key,next_run_at,created_at,updated_at)
     VALUES ('alice','job_00001','r','c','image','p','{}',20,'v1',?,'storing','users/alice/photos/media-job_00001',?,1,?)`,
  )
    .bind(`media:${'a'.repeat(64)}`, Number.MAX_SAFE_INTEGER, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO credit_reservations(idempotency_key,user_id,usage_kind,model_id,reserved_credits,status,created_at,updated_at)
     VALUES (?,'alice','video','image-01',20,'released',1,?)`,
  )
    .bind(`media:${'a'.repeat(64)}`, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO media_billing_reviews(reservation_key,user_id,job_id,reason,reserved_credits,hold_updated_at,created_at)
     VALUES (?,'alice','job_00001','released_with_asset',20,?,?)`,
  )
    .bind(`media:${'a'.repeat(64)}`, now, now)
    .run();
});
afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

const call = (actor: string, path: string, method = 'GET', body?: unknown, account = actor) =>
  handleMediaBillingReview(
    new Request(`https://test${path}`, {
      method,
      headers: { Authorization: `Bearer ${actor}`, 'X-Account-Id': account },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    {},
  );

it('requires an active matching admin and exposes bounded review evidence without changing the wallet', async () => {
  const path = '/api/auth/admin/billing/media-reconciliation';
  expect((await call('alice', path))?.status).toBe(403);
  expect((await call('admin', path, 'GET', undefined, 'alice'))?.status).toBe(403);
  expect((await call('admin', `${path}?before=bad`))?.status).toBe(400);
  const response = (await call('admin', path))!;
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const result = (await response.json()) as { items: Record<string, unknown>[]; nextCursor: null };
  expect(result.items).toHaveLength(1);
  expect(result.items[0]).toMatchObject({
    accountId: 'alice',
    reason: 'released_with_asset',
    reservationStatus: 'released',
    ledgerCount: 0,
    ledgerAmount: null,
    jobState: 'storing',
  });
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS count FROM credit_ledger WHERE kind='usage'").first(),
  ).toEqual({ count: 0 });
});

it('records idempotent version-bound operator notes, rejects stale observations and never releases the asset', async () => {
  const path = '/api/auth/admin/billing/media-reconciliation';
  const item = ((await (await call('admin', path))!.json()) as { items: Record<string, unknown>[] })
    .items[0]!;
  const body = {
    eventId: 'review-event-01',
    id: item.id,
    accountId: item.accountId,
    note: 'Checked provider and ledger evidence',
    observed: {
      createdAt: item.createdAt,
      jobUpdatedAt: item.jobUpdatedAt,
      reservationStatus: item.reservationStatus,
      reservationUpdatedAt: item.reservationUpdatedAt,
    },
  };
  expect((await call('alice', `${path}/notes`, 'POST', body))?.status).toBe(403);
  expect((await call('admin', `${path}/notes`, 'POST', body))?.status).toBe(200);
  expect((await call('admin', `${path}/notes`, 'POST', body))?.status).toBe(200);
  expect((await call('admin', `${path}/notes`, 'POST', { ...body, note: 'changed' }))?.status).toBe(
    409,
  );
  expect(
    (
      await call('admin', `${path}/notes`, 'POST', {
        ...body,
        eventId: 'review-event-02',
        observed: { ...body.observed, jobUpdatedAt: 1 },
      })
    )?.status,
  ).toBe(409);
  expect(
    await env.DB.prepare('SELECT COUNT(*) AS count FROM media_billing_review_notes').first(),
  ).toEqual({ count: 1 });
  expect(await env.DB.prepare('SELECT state FROM media_jobs').first()).toEqual({
    state: 'storing',
  });
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS count FROM credit_ledger WHERE kind='usage'").first(),
  ).toEqual({ count: 0 });
});
