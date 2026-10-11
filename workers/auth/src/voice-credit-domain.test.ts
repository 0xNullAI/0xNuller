import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { createTestDb } from './test-helpers';
import type { SessionEnv } from './session-domain';
import { finalizeVoiceReservation } from './voice-credit-domain';
import { creditBalance, reserveCredits, settleCredits, type Env } from './index';
import example from '@0xnullai/ai-pricing/example-price-table.json';
let db: ReturnType<typeof createTestDb>;
let env: SessionEnv;
const key = 'voice:reservation:1';
beforeEach(async () => {
  db = createTestDb();
  env = { DB: db.DB } as SessionEnv;
  await env.DB.prepare(
    'INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES (?,?,?,?,1)',
  )
    .bind('alice', 'alice', 'Alice', 'unused')
    .run();
  await env.DB.prepare(
    `INSERT INTO credit_reservations(idempotency_key,user_id,usage_kind,model_id,reserved_credits,status,created_at,updated_at) VALUES (?,'alice','voice','voice',100,'pending',?,?)`,
  )
    .bind(key, Date.now() - 30 * 60 * 1000, Date.now() - 30 * 60 * 1000)
    .run();
});
afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});
const finish = (
  action: 'settle' | 'release',
  durationMs = 0,
  subject = 'alice',
  reservationKey = key,
) =>
  finalizeVoiceReservation(env, subject, reservationKey, { action, durationMs }, 'credits-2026-09');
const ledger = () =>
  env.DB.prepare('SELECT amount_credits FROM credit_ledger WHERE reference_id=?')
    .bind(key)
    .all<{ amount_credits: number }>();

describe('private Voice reservation finalization', () => {
  it('settles a valid hold without an account session or unexpired browser ticket, exactly once', async () => {
    expect(await finish('settle', 10_001)).toEqual({ status: 'settled', charged: 40 });
    expect(await finish('settle', 40_000)).toEqual({ status: 'settled', charged: 40 });
    expect((await ledger()).results).toEqual([{ amount_credits: -40 }]);
  });
  it('does not charge a released reservation and concurrent settle/release agree with the ledger', async () => {
    const results = await Promise.all([finish('release'), finish('settle', 10_001)]);
    expect(results.every((result) => result.status === 'released')).toBe(true);
    expect((await ledger()).results).toEqual([]);
    expect(await finish('settle', 10_001)).toEqual({ status: 'released', charged: null });
  });
  it('concurrent settlements cannot insert different ledger amounts', async () => {
    const results = await Promise.all([finish('settle', 1), finish('settle', 30_000)]);
    expect(results).toEqual([
      { status: 'settled', charged: 20 },
      { status: 'settled', charged: 20 },
    ]);
    expect((await ledger()).results).toEqual([{ amount_credits: -20 }]);
  });
  it('caps charges to the original reservation and rejects invalid or foreign identities', async () => {
    expect(await finish('settle', 99_000, 'bob')).toEqual({ status: 'missing', charged: null });
    expect(await finish('settle', NaN)).toEqual({ status: 'rejected', charged: null });
    expect(await finish('settle', 99_000)).toEqual({ status: 'settled', charged: 100 });
    await env.DB.prepare(
      "UPDATE credit_reservations SET usage_kind='agent' WHERE idempotency_key=?",
    )
      .bind(key)
      .run();
    expect(await finish('release')).toEqual({ status: 'missing', charged: null });
  });
  it('rolls back the debit if updating the reservation fails and retries safely', async () => {
    await env.DB.prepare(
      `CREATE TRIGGER fail_settlement BEFORE UPDATE ON credit_reservations WHEN NEW.status='settled' BEGIN SELECT RAISE(ABORT,'storage failure'); END`,
    ).run();
    await expect(finish('settle', 1)).rejects.toThrow('storage failure');
    expect((await ledger()).results).toEqual([]);
    expect(
      await env.DB.prepare('SELECT status FROM credit_reservations WHERE idempotency_key=?')
        .bind(key)
        .first(),
    ).toEqual({ status: 'pending' });
    await env.DB.prepare('DROP TRIGGER fail_settlement').run();
    expect(await finish('settle', 1)).toEqual({ status: 'settled', charged: 20 });
  });
});

it('does not late-debit an expired Voice hold after its former balance was spent elsewhere', async () => {
  await env.DB.prepare(
    "INSERT INTO credit_ledger(user_id,amount_credits,kind,reference_id,created_at) VALUES('alice',100,'manual_purchase','fund:expired:voice',?)",
  )
    .bind(Date.now())
    .run();
  await env.DB.prepare(
    'UPDATE credit_reservations SET reserved_credits=80,updated_at=? WHERE idempotency_key=?',
  )
    .bind(Date.now() - 2 * 60 * 60 * 1000 - 1, key)
    .run();
  expect((await creditBalance(env as Env, 'alice')).available).toBe(100);
  expect(
    (
      await reserveCredits(env as Env, 'alice', {
        idempotencyKey: 'other:usage:001',
        usageKind: 'agent',
        modelId: 'balanced',
        credits: 80,
      })
    ).allowed,
  ).toBe(true);
  await settleCredits(env as Env, 'alice', 'other:usage:001', 80, {});
  expect((await creditBalance(env as Env, 'alice')).total).toBe(20);
  expect(await finish('settle', 40_000)).toEqual({ status: 'needs_review', charged: null });
  expect((await creditBalance(env as Env, 'alice')).total).toBe(20);
  expect((await ledger()).results).toEqual([]);
});

it('records one immutable expiry review across concurrent settle/release retries', async () => {
  await env.DB.prepare('UPDATE credit_reservations SET updated_at=? WHERE idempotency_key=?')
    .bind(Date.now() - 2 * 60 * 60 * 1000 - 1, key)
    .run();
  const replies = await Promise.all([
    finish('settle', 40_000),
    finish('settle', 80_000),
    finish('release'),
  ]);
  expect(replies).toEqual(Array(3).fill({ status: 'needs_review', charged: null }));
  expect(await finish('settle', 1)).toEqual({ status: 'needs_review', charged: null });
  expect((await ledger()).results).toEqual([]);
  expect((await env.DB.prepare('SELECT * FROM voice_billing_reviews').all()).results).toHaveLength(
    1,
  );
  expect(
    await env.DB.prepare(
      'SELECT status,charged_credits FROM credit_reservations WHERE idempotency_key=?',
    )
      .bind(key)
      .first(),
  ).toEqual({ status: 'released', charged_credits: null });
});
it('rolls back the expiry audit if release fails and retries the whole decision safely', async () => {
  await env.DB.prepare('UPDATE credit_reservations SET updated_at=1 WHERE idempotency_key=?')
    .bind(key)
    .run();
  await env.DB.prepare(
    "CREATE TRIGGER fail_expiry BEFORE UPDATE ON credit_reservations WHEN NEW.status='released' BEGIN SELECT RAISE(ABORT,'expiry storage failure'); END",
  ).run();
  await expect(finish('settle', 40_000)).rejects.toThrow('expiry storage failure');
  expect((await ledger()).results).toEqual([]);
  expect((await env.DB.prepare('SELECT * FROM voice_billing_reviews').all()).results).toEqual([]);
  expect(
    await env.DB.prepare('SELECT status FROM credit_reservations WHERE idempotency_key=?')
      .bind(key)
      .first(),
  ).toEqual({ status: 'pending' });
  await env.DB.prepare('DROP TRIGGER fail_expiry').run();
  expect(await finish('settle', 40_000)).toEqual({ status: 'needs_review', charged: null });
});
it('uses the database write clock when an RPC carries a stale pre-expiry application time', async () => {
  const now = Date.now();
  await env.DB.prepare('UPDATE credit_reservations SET updated_at=? WHERE idempotency_key=?')
    .bind(now - 2 * 60 * 60 * 1000 - 1000, key)
    .run();
  vi.spyOn(Date, 'now').mockReturnValue(now - 3 * 60 * 60 * 1000);
  expect(await finish('settle', 40_000)).toEqual({ status: 'needs_review', charged: null });
  expect((await ledger()).results).toEqual([]);
});
it('matches the exact wallet expiry boundary and never reviews an already settled debit', async () => {
  const now = Date.now() + 60 * 60 * 1000;
  vi.spyOn(Date, 'now').mockReturnValue(now);
  await env.DB.prepare('UPDATE credit_reservations SET updated_at=? WHERE idempotency_key=?')
    .bind(now - 2 * 60 * 60 * 1000 + 1, key)
    .run();
  expect(await finish('settle', 1)).toEqual({ status: 'settled', charged: 20 });
  vi.mocked(Date.now).mockReturnValue(now + 3 * 60 * 60 * 1000);
  expect(await finish('settle', 50_000)).toEqual({ status: 'settled', charged: 20 });
  expect((await env.DB.prepare('SELECT * FROM voice_billing_reviews').all()).results).toEqual([]);
});

describe('legacy settleVoiceCredits shared settlement boundary', () => {
  it('settles valid Voice holds using the same duration tariff and remains idempotent', async () => {
    const result = await settleCredits(env as Env, 'alice', key, 40, {
      model: 'voice',
      durationMs: 10_001,
    });
    expect(result).toMatchObject({ status: 'settled', charged: 40, allowed: false });
    expect(
      await settleCredits(env as Env, 'alice', key, 80, { model: 'voice', durationMs: 40_000 }),
    ).toMatchObject({ status: 'settled', charged: 40 });
    expect((await ledger()).results).toEqual([{ amount_credits: -40 }]);
  });
  it('maps expired review to legacy released without debit, including repeat calls', async () => {
    await env.DB.prepare('UPDATE credit_reservations SET updated_at=? WHERE idempotency_key=?')
      .bind(Date.now() - 2 * 60 * 60 * 1000 - 1000, key)
      .run();
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(
        await settleCredits(env as Env, 'alice', key, 80, { model: 'voice', durationMs: 40_000 }),
      ).toMatchObject({ status: 'released', charged: null, allowed: false });
    }
    expect((await ledger()).results).toEqual([]);
    expect(await finish('settle', 40_000)).toEqual({ status: 'needs_review', charged: null });
  });
});

describe('usage-billed Voice calls', () => {
  // Reserved 100; example realtime prices: input text 100, output audio 4000 per million.
  const usage = (overrides: Partial<Record<string, number>> = {}) => ({
    inputAudioTokens: 0,
    inputTextTokens: 0,
    cachedAudioTokens: 0,
    cachedTextTokens: 0,
    outputAudioTokens: 0,
    outputTextTokens: 0,
    ...overrides,
  });
  const settle = (input: Record<string, unknown>) =>
    finalizeVoiceReservation(
      env,
      'alice',
      key,
      { action: 'settle', durationMs: 30_000, ...input } as never,
      'credits-2026-09',
    );
  beforeEach(() => {
    env = { ...env, AI_PRICE_TABLE: JSON.stringify(example) } as SessionEnv;
  });
  const reviews = () => env.DB.prepare('SELECT * FROM voice_usage_reviews').all();

  it('charges the price-table cost of reported usage, with the table version and usage in the receipt', async () => {
    expect(
      await settle({
        usage: usage({ outputAudioTokens: 5_000, inputTextTokens: 10_000 }),
        rounds: 2,
        missingRounds: 0,
      }),
    ).toEqual({ status: 'settled', charged: Math.ceil((5_000 * 4000 + 10_000 * 100) / 1e6) });
    const entry = await env.DB.prepare(
      'SELECT price_version,metadata_json FROM credit_ledger WHERE reference_id=?',
    )
      .bind(key)
      .first<{ price_version: string; metadata_json: string }>();
    expect(entry?.price_version).toBe('realtime:example-1');
    expect(JSON.parse(entry!.metadata_json)).toMatchObject({
      model: 'example-realtime-model',
      rounds: 2,
      missingRounds: 0,
      usage: { outputAudioTokens: 5_000 },
    });
    expect((await reviews()).results).toEqual([]);
  });

  it('charges only reported usage and queues the call for review when a round has none', async () => {
    expect(
      await settle({ usage: usage({ outputAudioTokens: 5_000 }), rounds: 1, missingRounds: 2 }),
    ).toEqual({ status: 'settled', charged: 20 });
    expect((await reviews()).results).toMatchObject([
      {
        reason: 'usage_missing',
        rounds: 1,
        missing_rounds: 2,
        charged_credits: 20,
        computed_credits: 20,
      },
    ]);
  });

  it('releases a call with no billable usage, still reviewing unreported rounds', async () => {
    expect(await settle({ usage: usage(), rounds: 0, missingRounds: 1 })).toEqual({
      status: 'released',
      charged: null,
    });
    expect((await ledger()).results).toEqual([]);
    expect((await reviews()).results).toMatchObject([
      { reason: 'usage_missing', charged_credits: 0 },
    ]);
  });

  it('caps at the hold and reviews usage beyond it', async () => {
    expect(
      await settle({ usage: usage({ outputAudioTokens: 1_000_000 }), rounds: 9, missingRounds: 0 }),
    ).toEqual({ status: 'settled', charged: 100 });
    expect((await reviews()).results).toMatchObject([
      { reason: 'over_reservation', computed_credits: 4000, charged_credits: 100 },
    ]);
  });

  it('refuses malformed usage and never prices without a table', async () => {
    const rejected = { status: 'rejected', charged: null };
    expect(
      await settle({ usage: usage({ inputTextTokens: -1 }), rounds: 1, missingRounds: 0 }),
    ).toEqual(rejected);
    expect(await settle({ usage: usage(), rounds: 1 })).toEqual(rejected);
    expect(await settle({ rounds: 1, missingRounds: 0 })).toEqual(rejected);
    env = { ...env, AI_PRICE_TABLE: undefined } as SessionEnv;
    expect(
      await settle({ usage: usage({ outputAudioTokens: 5_000 }), rounds: 1, missingRounds: 0 }),
    ).toEqual(rejected);
    expect((await ledger()).results).toEqual([]);
  });
});
