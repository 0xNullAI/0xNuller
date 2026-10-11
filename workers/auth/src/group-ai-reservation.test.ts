import { afterEach, expect, it } from 'vitest';
import { AuthOwnershipService, type Env } from './index';
import { createTestDb } from './test-helpers';
import { sha256Body, signGroupAiTicket } from './group-ai-ticket';

const db = createTestDb();
afterEach(() => db.close());

it('reserves the verified triggering member once and rejects altered billing identity', async () => {
  const env = { DB: db.DB, DM_TICKET_SECRET: 'group-test-key' } as Env;
  const service = Object.create(AuthOwnershipService.prototype) as AuthOwnershipService;
  Object.assign(service, { env });
  await env.DB.prepare(
    "INSERT INTO users(id,username,display_name,password_hash,email_verified_at,created_at) VALUES('alice','alice','Alice','unused',1,1)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO credit_ledger(user_id,amount_credits,kind,reference_id,price_version,metadata_json,created_at) VALUES('alice',10,'support_adjustment','seed','test','{}',1)",
  ).run();
  const bodyHash = await sha256Body('{"model":"balanced","messages":[]}');
  const signed = await signGroupAiTicket(env.DM_TICKET_SECRET, {
    payer: 'alice',
    room: 'group-1',
    triggerId: 'message-1',
    roleId: 'room',
    grantId: '12345678-1234-4234-8234-123456789abc',
    modelId: 'balanced',
    bodyHash,
  });
  const input = {
    idempotencyKey: signed.reservationKey,
    modelId: 'balanced',
    credits: 2,
    bodyHash,
  };
  const first = await service.reserveManagedGroupTextCredits(signed.ticket, input);
  expect(first).toMatchObject({
    allowed: true,
    status: 'pending',
    groupContext: { payer: 'alice', room: 'group-1' },
  });
  expect(
    await env.DB.prepare(
      'SELECT user_id,room_id,trigger_id,role_id FROM group_ai_reservation_context',
    ).first(),
  ).toEqual({
    user_id: 'alice',
    room_id: 'group-1',
    trigger_id: 'message-1',
    role_id: 'room',
  });
  expect(await service.reserveManagedGroupTextCredits(signed.ticket, input)).toMatchObject({
    allowed: false,
    status: 'pending',
  });
  expect(
    await service.reserveManagedGroupTextCredits(signed.ticket, { ...input, modelId: 'powerful' }),
  ).toBe('unauthorized');
  expect(
    await service.reserveManagedGroupTextCredits(signed.ticket, {
      ...input,
      bodyHash: '0'.repeat(64),
    }),
  ).toBe('unauthorized');
  expect(
    await env.DB.prepare('SELECT COUNT(*) AS n FROM credit_reservations').first<{ n: number }>(),
  ).toEqual({ n: 1 });
  const second = await signGroupAiTicket(env.DM_TICKET_SECRET, {
    payer: 'alice',
    room: 'group-1',
    triggerId: 'message-2',
    roleId: 'room',
    grantId: '12345678-1234-4234-8234-123456789abc',
    modelId: 'balanced',
    bodyHash,
  });
  await env.DB.prepare(
    "CREATE TRIGGER reject_group_context BEFORE INSERT ON group_ai_reservation_context BEGIN SELECT RAISE(ABORT,'context unavailable'); END",
  ).run();
  await expect(
    service.reserveManagedGroupTextCredits(second.ticket, {
      ...input,
      idempotencyKey: second.reservationKey,
    }),
  ).rejects.toThrow();
  expect(
    await env.DB.prepare('SELECT status FROM credit_reservations WHERE idempotency_key=?')
      .bind(second.reservationKey)
      .first(),
  ).toEqual({ status: 'released' });
  expect(
    await env.DB.prepare('SELECT COUNT(*) AS n FROM group_ai_reservation_context').first(),
  ).toEqual({ n: 1 });
});
