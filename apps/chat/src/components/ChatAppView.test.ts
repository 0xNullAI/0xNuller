import { describe, expect, it, vi } from 'vitest';
import { leaveChatRoom, roomPresenceLabel } from './ChatAppView';

describe('Chat room/lobby shell composition', () => {
  it('describes group and direct-message presence without transport state', () => {
    expect(roomPresenceLabel(false, 0)).toBe('1 人在线 · 等待成员');
    expect(roomPresenceLabel(false, 2)).toBe('3 人在线');
    expect(roomPresenceLabel(true, 0)).toBe('对方不在线');
    expect(roomPresenceLabel(true, 1)).toBe('对方在线');
  });

  it('stops device output before leaving the room and clearing the DM header', () => {
    const events: string[] = [];

    leaveChatRoom(
      vi.fn(() => events.push('release')),
      vi.fn(() => events.push('leave')),
      vi.fn(() => events.push('clear-dm')),
    );

    expect(events).toEqual(['release', 'leave', 'clear-dm']);
  });
});
