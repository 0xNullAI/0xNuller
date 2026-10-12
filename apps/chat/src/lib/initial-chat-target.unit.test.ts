import { expect, it } from 'vitest';
import { initialChatTarget } from './initial-chat-target';

it.each([
  // A direct DM peer wins over a room link.
  ['?room=group&dm=peer-123', { kind: 'dm', accountId: 'peer-123' }],
  // A DM link requires a valid account id; an invalid one does not fall back to the room.
  ['?dm=', null],
  ['?dm=%2Fother&room=group', null],
  // Existing room links keep working.
  ['?room=group', { kind: 'room', code: 'group' }],
  // An ordinary chat entry selects nothing.
  ['', null],
])('resolves the initial chat target for %j', (search, expected) => {
  expect(initialChatTarget(search)).toEqual(expected);
});
