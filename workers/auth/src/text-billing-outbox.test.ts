import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDb } from './test-helpers';
import type { SessionEnv } from './session-domain';
import {
  heartbeatTextBilling,
  registerTextBilling,
  checkpointTextBilling,
  finalizeTextBilling,
  inspectTextBilling,
  runTextBilling,
} from './text-billing-outbox';
let db: ReturnType<typeof createTestDb>;
let env: SessionEnv;
let cap: string;
const key = 'text:reservation:1';
const metadata = {
  model: 'balanced',
  usage: { prompt_tokens: 1000, completion_tokens: 100 },
  priceVersion: 'workers-ai-credits-2026-09',
};
beforeEach(async () => {
  db = createTestDb();
  env = { DB: db.DB } as SessionEnv;
  await env.DB.prepare(
    "INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES('alice','alice','Alice','unused',1)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO credit_reservations(idempotency_key,user_id,usage_kind,model_id,reserved_credits,status,created_at,updated_at) VALUES(?,'alice','agent','balanced',20,'pending',?,?)",
  )
    .bind(key, Date.now(), Date.now())
    .run();
  cap = await registerTextBilling(env, key, 'alice');
});
afterEach(() => db.close());
const checkpoint = () => checkpointTextBilling(env, key, cap, 2, metadata);
const ledger = () => env.DB.prepare('SELECT amount_credits FROM credit_ledger').all();
it('recovers confirmed usage after process death without any browser session, once', async () => {
  await checkpoint();
  await runTextBilling(env, Date.now() + 11 * 60 * 1000);
  await runTextBilling(env, Date.now() + 12 * 60 * 1000);
  expect(await finalizeTextBilling(env, key, cap, 'settle')).toMatchObject({
    status: 'settled',
    charged: 2,
    recovery: 'settled',
  });
  expect((await ledger()).results).toEqual([{ amount_credits: -2 }]);
});
it('records interrupted unknown usage for review and releases without guessing', async () => {
  await runTextBilling(env, Date.now() + 11 * 60 * 1000);
  expect(await inspectTextBilling(env, key, cap)).toMatchObject({
    status: 'released',
    recovery: 'needs_review',
  });
  expect((await ledger()).results).toEqual([]);
});
it('rejects foreign capabilities, unsupported metadata and release after confirmed usage', async () => {
  expect(await inspectTextBilling(env, key, 'wrong')).toMatchObject({ status: 'missing' });
  await expect(
    checkpointTextBilling(env, key, cap, 2, { ...metadata, model: 'voice' }),
  ).rejects.toThrow();
  await checkpoint();
  await expect(finalizeTextBilling(env, key, cap, 'release')).rejects.toThrow('usage_confirmed');
  expect((await ledger()).results).toEqual([]);
});
it('durable intent survives transactional failure and concurrent retries debit once', async () => {
  await checkpoint();
  await env.DB.prepare(
    "CREATE TRIGGER fail_text BEFORE UPDATE ON credit_reservations WHEN NEW.status='settled' BEGIN SELECT RAISE(ABORT,'storage failure'); END",
  ).run();
  await expect(finalizeTextBilling(env, key, cap, 'settle')).rejects.toThrow('storage failure');
  expect(await inspectTextBilling(env, key, cap)).toMatchObject({
    status: 'pending',
    recovery: 'ready',
  });
  expect((await ledger()).results).toEqual([]);
  await env.DB.prepare('DROP TRIGGER fail_text').run();
  await Promise.all([runTextBilling(env), finalizeTextBilling(env, key, cap, 'settle')]);
  expect((await ledger()).results).toEqual([{ amount_credits: -2 }]);
});
it('does not debit an expired hold after its credits became spendable elsewhere', async () => {
  await checkpoint();
  await runTextBilling(env, Date.now() + 3 * 60 * 60 * 1000);
  expect(await inspectTextBilling(env, key, cap)).toMatchObject({
    status: 'released',
    recovery: 'needs_review',
  });
  expect((await ledger()).results).toEqual([]);
});
it('does not resurrect a released task or accept a lower checkpoint', async () => {
  await checkpoint();
  await expect(checkpointTextBilling(env, key, cap, 1, metadata)).rejects.toThrow('conflict');
  await finalizeTextBilling(env, key, cap, 'settle');
  await expect(checkpoint()).rejects.toThrow();
  expect(await finalizeTextBilling(env, key, cap, 'release')).toMatchObject({
    status: 'settled',
    charged: 2,
  });
});
it('preserves usage if release races a checkpoint', async () => {
  await Promise.allSettled([checkpoint(), finalizeTextBilling(env, key, cap, 'release')]);
  const state = await inspectTextBilling(env, key, cap);
  if (state.status === 'released') {
    expect((await ledger()).results).toEqual([]);
  } else {
    await runTextBilling(env, Date.now() + 11 * 60 * 1000);
    expect(await inspectTextBilling(env, key, cap)).toMatchObject({
      status: 'settled',
      charged: 2,
    });
  }
});
it('backs off failed recovery and retries after the persisted deadline', async () => {
  await checkpoint();
  await env.DB.prepare(
    "CREATE TRIGGER fail_retry BEFORE UPDATE ON credit_reservations WHEN NEW.status='settled' BEGIN SELECT RAISE(ABORT,'retry failure'); END",
  ).run();
  const now = Date.now() + 11 * 60 * 1000;
  await runTextBilling(env, now);
  expect(
    await env.DB.prepare('SELECT attempts,next_attempt_at FROM text_billing_outbox').first(),
  ).toEqual({ attempts: 1, next_attempt_at: now + 30000 });
  await env.DB.prepare('DROP TRIGGER fail_retry').run();
  await runTextBilling(env, now + 1000);
  expect((await ledger()).results).toEqual([]);
  await runTextBilling(env, now + 30001);
  expect((await ledger()).results).toEqual([{ amount_credits: -2 }]);
});

it('heartbeats protect long active streams but do not extend the reservation TTL', async () => {
  const now = Date.now();
  expect(await heartbeatTextBilling(env, key, cap, now + 9 * 60 * 1000)).toEqual({
    status: 'running',
  });
  await runTextBilling(env, now + 11 * 60 * 1000);
  expect(await inspectTextBilling(env, key, cap)).toMatchObject({
    status: 'pending',
    recovery: 'running',
  });
  expect(await heartbeatTextBilling(env, key, 'wrong', now + 11 * 60 * 1000)).toEqual({
    status: 'rejected',
  });
  expect(await heartbeatTextBilling(env, key, cap, now + 3 * 60 * 60 * 1000)).toEqual({
    status: 'rejected',
  });
  await runTextBilling(env, now + 3 * 60 * 60 * 1000);
  expect(await inspectTextBilling(env, key, cap)).toMatchObject({
    status: 'released',
    recovery: 'needs_review',
  });
});

it('releases a newly reserved hold if task registration fails before generation can start', async () => {
  await env.DB.prepare('DELETE FROM text_billing_outbox').run();
  await env.DB.prepare(
    "CREATE TRIGGER fail_registration BEFORE INSERT ON text_billing_outbox BEGIN SELECT RAISE(ABORT,'registration failure'); END",
  ).run();
  await expect(registerTextBilling(env, key, 'alice')).rejects.toThrow('registration failure');
  expect(
    await env.DB.prepare('SELECT status FROM credit_reservations WHERE idempotency_key=?')
      .bind(key)
      .first(),
  ).toEqual({ status: 'released' });
  expect((await ledger()).results).toEqual([]);
});

it('binds a visual request hash to its reservation and refuses a mismatched checkpoint', async () => {
  const visionKey = 'vision:reservation:001';
  const hash = 'a'.repeat(64);
  await env.DB.prepare(
    "INSERT INTO credit_reservations(idempotency_key,user_id,usage_kind,model_id,reserved_credits,status,created_at,updated_at) VALUES(?,'alice','video','vision',59,'pending',?,?)",
  )
    .bind(visionKey, Date.now(), Date.now())
    .run();
  const visionCap = await registerTextBilling(env, visionKey, 'alice', hash);
  expect(
    await env.DB.prepare('SELECT request_hash FROM text_billing_outbox WHERE reservation_key=?')
      .bind(visionKey)
      .first(),
  ).toEqual({ request_hash: hash });
  const details = { ...metadata, model: 'vision', requestHash: hash };
  await expect(
    checkpointTextBilling(env, visionKey, visionCap, 2, {
      ...details,
      requestHash: 'b'.repeat(64),
    }),
  ).rejects.toThrow('rejected');
  expect(await checkpointTextBilling(env, visionKey, visionCap, 2, details)).toEqual({
    status: 'checkpointed',
  });
  expect(await finalizeTextBilling(env, visionKey, visionCap, 'settle')).toMatchObject({
    status: 'settled',
    charged: 2,
  });
});
