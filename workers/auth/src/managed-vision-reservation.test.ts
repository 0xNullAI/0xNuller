import { expect, it } from 'vitest';
import {
  MANAGED_VISION_RESERVATION_CREDITS,
  validManagedTextReservation,
} from './managed-vision-reservation';

const vision = {
  usageKind: 'video' as const,
  modelId: 'vision',
  credits: MANAGED_VISION_RESERVATION_CREDITS,
  context: { conversationId: 'private-chat', runId: 'run:vision:001' },
  bodyHash: 'a'.repeat(64),
};

const chat = { ...vision, modelId: 'chat-vision', usageKind: 'agent' as const };

it('accepts only server-priced, same-kind, bound and hashed vision reservations and listed text tiers', () => {
  expect(MANAGED_VISION_RESERVATION_CREDITS).toBe(59);
  const cases: Array<[string, Parameters<typeof validManagedTextReservation>[0], boolean]> = [
    // Video vision needs the server-priced hold, camera usage, conversation and exact request hash.
    ['video vision', vision, true],
    ['video vision with a client price', { ...vision, credits: 1 }, false],
    ['video vision as agent usage', { ...vision, usageKind: 'agent' as const }, false],
    ['video vision without a conversation', { ...vision, context: undefined }, false],
    ['video vision with a bad request hash', { ...vision, bodyHash: 'not-a-sha256' }, false],
    // Existing text tiers stay valid; unlisted models are rejected.
    ['balanced text tier', { ...vision, modelId: 'balanced', bodyHash: undefined }, true],
    ['unlisted model', { ...vision, modelId: '@cf/private/model' }, false],
    // Private chat vision is quoted independently from Video; cross-kind reservations fail.
    ['private chat vision', chat, true],
    ['private chat vision as video usage', { ...chat, usageKind: 'video' as const }, false],
    ['private chat vision with a client price', { ...chat, credits: 1 }, false],
    ['private chat vision without a conversation', { ...chat, context: undefined }, false],
    ['private chat vision without a request hash', { ...chat, bodyHash: undefined }, false],
  ];
  for (const [name, reservation, valid] of cases)
    expect(validManagedTextReservation(reservation), name).toBe(valid);
});
