import { describe, expect, it } from 'vitest';
import appSource from './App.tsx?raw';

describe('Chat inside the unified shell', () => {
  it('keeps an explicit leave-room action in the shell header', () => {
    expect(appSource).toContain('{inShell && peerRoom.roomId && (');
    expect(appSource).toContain("title={peerRoom.isDm ? '关闭私聊' : '离开房间'}");
    expect(appSource).toContain("<span>{peerRoom.isDm ? '关闭' : '退出'}</span>");
  });

  it('wires the room sidebar action to leave the active room', () => {
    expect(appSource).toContain('if (peerRoom.roomId === code) peerRoom.leave();');
  });
});
