import { describe, expect, it, vi } from 'vitest';
import viewSource from './ChatAppView.tsx?raw';
import { leaveChatRoom, roomPresenceLabel } from './ChatAppView';

describe('Chat room/lobby shell composition', () => {
  it('describes group and direct-message presence without transport state', () => {
    expect(roomPresenceLabel(false, 0)).toBe('等待成员');
    expect(roomPresenceLabel(false, 2)).toBe('3 人在线');
    expect(roomPresenceLabel(true, 0)).toBe('对方不在线');
    expect(roomPresenceLabel(true, 1)).toBe('对方在线');
  });

  it('disconnects device output before leaving the room and clearing the DM header', () => {
    const events: string[] = [];

    leaveChatRoom(
      vi.fn(() => events.push('disconnect')),
      vi.fn(() => events.push('leave')),
      vi.fn(() => events.push('clear-dm')),
    );

    expect(events).toEqual(['disconnect', 'leave', 'clear-dm']);
  });

  it('keeps explicit shell leave and active-room sidebar actions in the extracted view', () => {
    expect(viewSource).toContain('{inShell && peerRoom.roomId && (');
    expect(viewSource).toContain("title={peerRoom.isDm ? '关闭私聊' : '离开房间'}");
    expect(viewSource).toContain("<span>{peerRoom.isDm ? '关闭' : '退出'}</span>");
    expect(viewSource).toContain('if (peerRoom.roomId === code) peerRoom.leave();');
  });
});
