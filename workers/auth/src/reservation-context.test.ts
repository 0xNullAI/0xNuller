import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createTestDb } from './test-helpers';
import { reserveWithContext } from './reservation-context';
import { reserveCredits, type Env } from './index';
let db: ReturnType<typeof createTestDb>;
let env: Env;
const key = 'credit:context:001';
const context = { conversationId: 'private-chat', runId: 'run:actual:001' };
beforeEach(async () => {
  db = createTestDb();
  env = { DB: db.DB } as Env;
  for (const user of ['alice', 'bob']) {
    await env.DB.prepare(
      'INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,?,1)',
    )
      .bind(user, user, user, 'unused')
      .run();
    await env.DB.prepare(
      "INSERT INTO credit_ledger(user_id,amount_credits,kind,reference_id,created_at) VALUES(?,100,'manual_purchase',?,1)",
    )
      .bind(user, `fund:${user}`)
      .run();
  }
  await env.DB.prepare(
    `INSERT INTO server_conversations(user_id,id,created_at,updated_at,mutation_id,metadata) VALUES('alice','private-chat',1,1,'test','{"relationshipId":"original-relation"}')`,
  ).run();
});
afterEach(() => db.close());
const reserve = (user = 'alice', ctx: unknown = context) =>
  reserveWithContext(env, user, key, ctx, () =>
    reserveCredits(env, user, {
      idempotencyKey: key,
      usageKind: 'agent',
      modelId: 'balanced',
      credits: 10,
    }),
  );
it('snapshots an owned conversation/run and relationship, without deriving history from later settings', async () => {
  expect((await reserve()).allowed).toBe(true);
  await env.DB.prepare(
    `UPDATE server_conversations SET metadata='{"relationshipId":"changed-relation"}'`,
  ).run();
  expect((await reserve('alice', { ...context, runId: 'different:run' })).allowed).toBe(false);
  expect(
    await env.DB.prepare(
      'SELECT conversation_id,run_id,relationship_id FROM reservation_context',
    ).first(),
  ).toEqual({
    conversation_id: 'private-chat',
    run_id: 'run:actual:001',
    relationship_id: 'original-relation',
  });
});
it('rejects foreign/deleted conversations before freezing credit', async () => {
  await expect(reserve('bob')).rejects.toThrow('not_owned');
  await env.DB.prepare('UPDATE server_conversations SET deleted_at=1').run();
  await expect(reserve()).rejects.toThrow('not_owned');
  expect((await env.DB.prepare('SELECT * FROM credit_reservations').all()).results).toEqual([]);
});
it('does not start work if the snapshot write fails, and releases the created hold', async () => {
  await env.DB.prepare(
    "CREATE TRIGGER fail_context BEFORE INSERT ON reservation_context BEGIN SELECT RAISE(ABORT,'context write failed'); END",
  ).run();
  await expect(reserve()).rejects.toThrow('context write failed');
  expect(await env.DB.prepare('SELECT status FROM credit_reservations').first()).toEqual({
    status: 'released',
  });
});
it('explicitly absent context remains unknown without reading mutable session settings', async () => {
  const action = vi.fn().mockResolvedValue({ allowed: true });
  expect(await reserveWithContext(env, 'alice', key, undefined, action)).toEqual({ allowed: true });
  expect(action).toHaveBeenCalledOnce();
  expect((await env.DB.prepare('SELECT * FROM reservation_context').all()).results).toEqual([]);
});

it('concurrent duplicate reservations create one immutable snapshot and never release the winner', async () => {
  const outcomes = await Promise.all([
    reserve(),
    reserve('alice', { ...context, runId: 'another:run:001' }),
  ]);
  expect(outcomes.filter((x) => x.allowed)).toHaveLength(1);
  expect(await env.DB.prepare('SELECT status FROM credit_reservations').first()).toEqual({
    status: 'pending',
  });
  expect((await env.DB.prepare('SELECT * FROM reservation_context').all()).results).toHaveLength(1);
});
it('does not release an existing pending hold even if a faulty reserve callback reports allowed', async () => {
  await reserve();
  const result = await reserveWithContext(
    env,
    'alice',
    key,
    { ...context, runId: 'wrong:run:001' },
    async () => ({ allowed: true, created: true }),
  );
  expect(result.allowed).toBe(false);
  expect(await env.DB.prepare('SELECT status FROM credit_reservations').first()).toEqual({
    status: 'pending',
  });
  expect(await env.DB.prepare('SELECT run_id FROM reservation_context').first()).toEqual({
    run_id: 'run:actual:001',
  });
});
