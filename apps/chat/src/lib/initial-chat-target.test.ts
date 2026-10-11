import { expect, it } from 'vitest';
import { initialChatTarget } from './initial-chat-target';

it('prefers a direct DM peer over a room and requires a valid account id', () => {
  expect(initialChatTarget('?room=group&dm=peer-123')).toEqual({
    kind: 'dm',
    accountId: 'peer-123',
  });
  expect(initialChatTarget('?dm=')).toBeNull();
  expect(initialChatTarget('?dm=%2Fother&room=group')).toBeNull();
});

it('keeps existing room links and leaves an ordinary chat entry unselected', () => {
  expect(initialChatTarget('?room=group')).toEqual({ kind: 'room', code: 'group' });
  expect(initialChatTarget('')).toBeNull();
});
