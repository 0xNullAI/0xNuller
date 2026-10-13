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

it('gives every model call of one turn its own reservation, never reusing round 0', async () => {
  const secret = 'test-only-shared-key';
  const now = 1_000_000;
  const bodyHash = await sha256Body('{}');
  const input = {
    payer: 'alice',
    room: 'group-1',
    triggerId: 'message-1',
    roleId: 'a1',
    grantId: '12345678-1234-4234-8234-123456789abc',
    modelId: 'balanced' as const,
    bodyHash,
  };
  const first = await signGroupAiTicket(secret, input, now);
  const second = await signGroupAiTicket(secret, { ...input, round: 1 }, now);
  expect(second.reservationKey).not.toBe(first.reservationKey);
  expect(
    await verifyGroupAiTicket(
      secret,
      second.ticket,
      { reservationKey: second.reservationKey, modelId: 'balanced', bodyHash },
      now,
    ),
  ).toMatchObject({ round: 1 });
  // A later round's ticket cannot be spent against the first round's reservation.
  expect(
    await verifyGroupAiTicket(
      secret,
      second.ticket,
      { reservationKey: first.reservationKey, modelId: 'balanced', bodyHash },
      now,
    ),
  ).toBeNull();
  await expect(signGroupAiTicket(secret, { ...input, round: 4 }, now)).rejects.toThrow();
});
