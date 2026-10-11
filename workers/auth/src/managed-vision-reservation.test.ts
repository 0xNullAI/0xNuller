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

it('requires server-priced vision hold, camera usage, conversation and exact request hash', () => {
  expect(MANAGED_VISION_RESERVATION_CREDITS).toBe(59);
  expect(validManagedTextReservation(vision)).toBe(true);
  expect(validManagedTextReservation({ ...vision, credits: 1 })).toBe(false);
  expect(validManagedTextReservation({ ...vision, usageKind: 'agent' })).toBe(false);
  expect(validManagedTextReservation({ ...vision, context: undefined })).toBe(false);
  expect(validManagedTextReservation({ ...vision, bodyHash: 'not-a-sha256' })).toBe(false);
});

it('keeps existing text tiers and rejects unlisted models', () => {
  expect(validManagedTextReservation({ ...vision, modelId: 'balanced', bodyHash: undefined })).toBe(
    true,
  );
  expect(validManagedTextReservation({ ...vision, modelId: '@cf/private/model' })).toBe(false);
});

it('quotes private chat vision independently from Video and rejects cross-kind reservations', () => {
  const chat = { ...vision, modelId: 'chat-vision', usageKind: 'agent' as const };
  expect(validManagedTextReservation(chat)).toBe(true);
  expect(validManagedTextReservation({ ...chat, usageKind: 'video' })).toBe(false);
  expect(validManagedTextReservation({ ...chat, credits: 1 })).toBe(false);
  expect(validManagedTextReservation({ ...chat, context: undefined })).toBe(false);
  expect(validManagedTextReservation({ ...chat, bodyHash: undefined })).toBe(false);
});
