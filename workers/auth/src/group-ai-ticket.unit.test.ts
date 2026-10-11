import { expect, it } from 'vitest';
import {
  groupAiReservationKey,
  sha256Body,
  signGroupAiTicket,
  verifyGroupAiTicket,
} from './group-ai-ticket';

it('binds a short group AI billing ticket to payer, room, trigger, role, model and exact body', async () => {
  const secret = 'test-only-shared-key';
  const now = 1_000_000;
  const bodyHash = await sha256Body('{"messages":[{"role":"user","content":"hi"}]}');
  const signed = await signGroupAiTicket(
    secret,
    {
      payer: 'alice',
      room: 'group-1',
      triggerId: 'message-1',
      roleId: 'room',
      grantId: '12345678-1234-4234-8234-123456789abc',
      modelId: 'balanced',
      bodyHash,
    },
    now,
  );
  expect(signed.reservationKey).toBe(await groupAiReservationKey('group-1', 'message-1', 'room'));
  const expected = { reservationKey: signed.reservationKey, modelId: 'balanced', bodyHash };
  expect(await verifyGroupAiTicket(secret, signed.ticket, expected, now + 1)).toMatchObject({
    payer: 'alice',
    room: 'group-1',
    triggerId: 'message-1',
    roleId: 'room',
  });
  expect(
    await verifyGroupAiTicket(secret, signed.ticket, { ...expected, modelId: 'powerful' }, now),
  ).toBeNull();
  expect(
    await verifyGroupAiTicket(
      secret,
      signed.ticket,
      { ...expected, bodyHash: '0'.repeat(64) },
      now,
    ),
  ).toBeNull();
  expect(
    await verifyGroupAiTicket(
      secret,
      signed.ticket,
      { ...expected, reservationKey: 'group-ai:' + '0'.repeat(64) },
      now,
    ),
  ).toBeNull();
  expect(await verifyGroupAiTicket('wrong-key', signed.ticket, expected, now)).toBeNull();
  expect(await verifyGroupAiTicket(secret, signed.ticket, expected, now + 70_000)).toBeNull();
});
