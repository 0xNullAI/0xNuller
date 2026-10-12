import { expect, it } from 'vitest';
import { validManagedTextReservation } from './managed-vision-reservation';

const vision = {
  usageKind: 'video' as const,
  modelId: 'vision',
  credits: 12,
  context: { conversationId: 'private-chat', runId: 'run:vision:001' },
  bodyHash: 'a'.repeat(64),
};

const chat = { ...vision, modelId: 'chat-vision', usageKind: 'agent' as const };

it('accepts only priced, same-kind, bound and hashed vision reservations and listed text ids', () => {
  const cases: Array<[string, Parameters<typeof validManagedTextReservation>[0], boolean]> = [
    // Video vision needs a whole-Credit hold, camera usage, conversation and exact request hash.
    ['video vision', vision, true],
    ['video vision with a fractional hold', { ...vision, credits: 1.5 }, false],
    ['video vision with no hold', { ...vision, credits: 0 }, false],
    ['video vision as agent usage', { ...vision, usageKind: 'agent' as const }, false],
    ['video vision without a conversation', { ...vision, context: undefined }, false],
    ['video vision with a bad request hash', { ...vision, bodyHash: 'not-a-sha256' }, false],
    // Former text tiers stay valid for older clients; unlisted models are rejected.
    ['balanced text id', { ...vision, modelId: 'balanced', bodyHash: undefined }, true],
    ['former basic text id', { ...vision, modelId: 'basic', bodyHash: undefined }, true],
    ['unlisted model', { ...vision, modelId: 'upstream/private-model' }, false],
    // Private chat vision is bound independently from Video; cross-kind reservations fail.
    ['private chat vision', chat, true],
    ['private chat vision as video usage', { ...chat, usageKind: 'video' as const }, false],
    ['private chat vision with a negative hold', { ...chat, credits: -1 }, false],
    ['private chat vision without a conversation', { ...chat, context: undefined }, false],
    ['private chat vision without a request hash', { ...chat, bodyHash: undefined }, false],
  ];
  for (const [name, reservation, valid] of cases)
    expect(validManagedTextReservation(reservation), name).toBe(valid);
});
