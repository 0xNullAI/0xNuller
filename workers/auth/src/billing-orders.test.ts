import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { createTestDb } from './test-helpers';
import { sha256Hex, type SessionEnv } from './session-domain';
import {
  handleBillingOrders,
  applyVerifiedBillingEvent,
  type VerifiedBillingEvent,
} from './billing-orders';
let db: ReturnType<typeof createTestDb>;
let env: SessionEnv;
const now = 1800000000000;
beforeEach(async () => {
  db = createTestDb();
  env = { DB: db.DB } as SessionEnv;
  vi.spyOn(Date, 'now').mockReturnValue(now);
  for (const user of ['alice', 'bob', 'admin']) {
    await env.DB.prepare(
      'INSERT INTO users(id,username,display_name,password_hash,created_at,role) VALUES (?,?,?,?,1,?)',
    )
      .bind(user, user, user, 'unused', user === 'admin' ? 'admin' : 'user')
      .run();
    await env.DB.prepare(
      'INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES (?,?,1,?)',
    )
      .bind(await sha256Hex(user), user, now + 86400000)
      .run();
  }
});
afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});
const draft = { packageId: 'credit-1000', priceVersion: 'credits-2026-09' };
async function call(
  path = '/orders/order_001',
  method = 'PUT',
  body: unknown = draft,
  user = 'alice',
  admin = false,
) {
  return (await handleBillingOrders(
    new Request(`https://test/api/auth/${admin ? 'admin/' : ''}billing${path}`, {
      method,
      headers: { Authorization: `Bearer ${user}`, 'X-Account-Id': user },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
    }),
    env,
    {},
  ))!;
}
const paid: VerifiedBillingEvent = {
  provider: 'manual',
  eventId: 'event_001',
  orderId: 'order_001',
  paymentId: 'receipt_001',
  kind: 'paid',
  amountMinor: 700,
  currency: 'CNY',
  operatorUserId: 'admin',
};
const balance = async (user = 'alice') =>
  (await env.DB.prepare(
    'SELECT COALESCE(SUM(amount_credits),0) AS total FROM credit_ledger WHERE user_id=?',
  )
    .bind(user)
    .first<{ total: number }>())!.total;
const count = async (table: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
describe('orders, verified payment events and reconciliation', () => {
  it('pins server prices and never funds an order or unsigned browser callback', async () => {
    expect((await call()).status).toBe(201);
    expect((await call()).status).toBe(200);
    expect(await balance()).toBe(0);
    expect(
      (await call('/orders/order_001', 'PUT', { ...draft, packageId: 'credit-5000' })).status,
    ).toBe(409);
    expect((await call('/orders/order_001', 'GET', undefined, 'bob')).status).toBe(404);
    expect((await call('/webhook', 'POST', { ...paid, verified: true })).status).toBe(503);
    expect(await balance()).toBe(0);
    expect(
      (
        await call(
          '/orders/order_001/confirm-payment',
          'POST',
          { ...paid, confirmedExternalPayment: true },
          'alice',
          true,
        )
      ).status,
    ).toBe(403);
  });
  it('atomically credits an exact verified payment and accepts duplicate events once', async () => {
    await call();
    expect(await applyVerifiedBillingEvent(env, paid)).toEqual({ state: 'applied' });
    expect(await applyVerifiedBillingEvent(env, paid)).toEqual({ state: 'applied' });
    expect(await applyVerifiedBillingEvent(env, { ...paid, eventId: 'event_002' })).toEqual({
      state: 'applied',
    });
    expect(await balance()).toBe(1000);
    expect(await count('credit_ledger')).toBe(1);
    expect(await count('admin_credit_audit')).toBe(1);
    expect((await applyVerifiedBillingEvent(env, { ...paid, amountMinor: 3500 })).state).toBe(
      'conflict',
    );
  });
  it('keeps mismatches, late receipts and reused legacy references for reconciliation without granting Credit', async () => {
    await call();
    expect((await applyVerifiedBillingEvent(env, { ...paid, amountMinor: 701 })).state).toBe(
      'needs_review',
    );
    expect(await balance()).toBe(0);
    await call('/orders/order_002');
    await env.DB.prepare(
      "INSERT INTO credit_ledger(user_id,amount_credits,kind,reference_id,price_version,created_at) VALUES ('bob',1000,'manual_purchase','legacy_receipt','legacy',1)",
    ).run();
    expect(
      (
        await applyVerifiedBillingEvent(env, {
          ...paid,
          eventId: 'event_legacy',
          orderId: 'order_002',
          paymentId: 'legacy_receipt',
        })
      ).state,
    ).toBe('needs_review');
    expect(await balance()).toBe(0);
    expect(await balance('bob')).toBe(1000);
    await call('/orders/order_003');
    await env.DB.prepare("UPDATE billing_orders SET expires_at=1 WHERE id='order_003'").run();
    expect(
      (
        await applyVerifiedBillingEvent(env, {
          ...paid,
          eventId: 'event_late',
          orderId: 'order_003',
        })
      ).state,
    ).toBe('needs_review');
  });
  it('rejects concurrent conflicting event payloads rather than reporting a false replay', async () => {
    await call();
    const results = await Promise.all([
      applyVerifiedBillingEvent(env, paid),
      applyVerifiedBillingEvent(env, { ...paid, amountMinor: 701 }),
    ]);
    expect(results.filter((r) => r.state === 'conflict')).toHaveLength(1);
    expect(await count('billing_events')).toBe(1);
    expect(await balance()).toBeLessThanOrEqual(1000);
  });
  it('does not allocate one payment to two concurrent accounts', async () => {
    await call();
    await call('/orders/order_002', 'PUT', draft, 'bob');
    const results = await Promise.all([
      applyVerifiedBillingEvent(env, paid),
      applyVerifiedBillingEvent(env, { ...paid, eventId: 'event_002', orderId: 'order_002' }),
    ]);
    expect(results.map((r) => r.state).sort()).toEqual(['applied', 'needs_review']);
    expect((await balance()) + (await balance('bob'))).toBe(1000);
  });
  it('rolls back payment, event, order and ledger together on an audit failure', async () => {
    await call();
    await env.DB.prepare(
      "CREATE TRIGGER fail_audit BEFORE INSERT ON admin_credit_audit BEGIN SELECT RAISE(ABORT,'offline'); END",
    ).run();
    await expect(applyVerifiedBillingEvent(env, paid)).rejects.toThrow();
    expect(await balance()).toBe(0);
    expect(await count('billing_events')).toBe(0);
    expect(await count('billing_payments')).toBe(0);
    await env.DB.prepare('DROP TRIGGER fail_audit').run();
    expect((await applyVerifiedBillingEvent(env, paid)).state).toBe('applied');
  });
  it('records a refund request without sending money, and debits once after verified full refund', async () => {
    await call();
    await applyVerifiedBillingEvent(env, paid);
    expect(
      (await call('/orders/order_001/refund-request', 'POST', { version: 2, reason: '不再需要' }))
        .status,
    ).toBe(200);
    expect(await balance()).toBe(1000);
    const refund = { ...paid, kind: 'refunded' as const, eventId: 'refund_001' };
    expect((await applyVerifiedBillingEvent(env, refund)).state).toBe('applied');
    expect((await applyVerifiedBillingEvent(env, refund)).state).toBe('applied');
    expect(await balance()).toBe(0);
    expect(await env.DB.prepare('SELECT status FROM billing_orders').first()).toEqual({
      status: 'refunded',
    });
  });
  it('does not remove live AI reservations for refund; unresolved cash refunds stay visible for review', async () => {
    await call();
    await applyVerifiedBillingEvent(env, paid);
    await env.DB.prepare(
      "INSERT INTO credit_reservations(idempotency_key,user_id,usage_kind,model_id,reserved_credits,status,created_at,updated_at) VALUES ('active_call','alice','voice','voice',20,'pending',?,?)",
    )
      .bind(now, now)
      .run();
    expect(
      (await applyVerifiedBillingEvent(env, { ...paid, kind: 'refunded', eventId: 'refund_001' }))
        .state,
    ).toBe('needs_review');
    expect(await balance()).toBe(1000);
    expect(await env.DB.prepare('SELECT status FROM credit_reservations').first()).toEqual({
      status: 'pending',
    });
  });
  it('keeps prior wallet rows intact and enforces the existing administrator daily cap', async () => {
    await call();
    await env.DB.prepare(
      "INSERT INTO admin_credit_audit(operator_user_id,target_user_id,action,amount_cny,amount_credits,external_reference,created_at) VALUES ('admin','bob','manual_purchase',1400,200000,'prior_receipt',?)",
    )
      .bind(now)
      .run();
    expect((await applyVerifiedBillingEvent(env, paid)).state).toBe('needs_review');
    expect(await balance()).toBe(0);
  });
});
