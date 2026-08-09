import { beforeEach, describe, expect, it } from 'vitest';
import type { DmConversation } from '@0xnullai/auth';
import { loadDmRead, markDmRead, mergeDmList } from './dm';

/**
 * The sidebar's two visible promises: newest conversation first, and a badge that means
 * something. Both are computed here rather than by the server, so both are worth pinning.
 */

function peer(id: string, room: string, startedAt: number): DmConversation {
  return { id, username: id, displayName: id, startedAt, room };
}

beforeEach(() => localStorage.clear());

describe('私聊列表排序', () => {
  it('最近说话的排在最前', () => {
    const a = peer('a', 'dm:a', 100);
    const b = peer('b', 'dm:b', 200);
    const list = mergeDmList(
      [a, b],
      [
        { room: 'dm:a', lastTs: 900, unread: 0 },
        { room: 'dm:b', lastTs: 300, unread: 0 },
      ],
    );
    expect(list.map((e) => e.peer.id)).toEqual(['a', 'b']);
  });

  it('一句话都还没说的会话按开始时间排，不会沉到最底下', () => {
    // Otherwise starting a conversation files it below everything, which is the opposite of
    // where the person who just started it is looking.
    const fresh = peer('fresh', 'dm:fresh', 1000);
    const old = peer('old', 'dm:old', 1);
    const list = mergeDmList([old, fresh], [{ room: 'dm:old', lastTs: 500, unread: 0 }]);
    expect(list.map((e) => e.peer.id)).toEqual(['fresh', 'old']);
  });

  it('服务端没给汇总时按零处理，而不是消失', () => {
    const list = mergeDmList([peer('a', 'dm:a', 5)], []);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ lastTs: 0, unread: 0 });
  });

  it('未读数原样带出来', () => {
    const list = mergeDmList([peer('a', 'dm:a', 5)], [{ room: 'dm:a', lastTs: 9, unread: 3 }]);
    expect(list[0]!.unread).toBe(3);
  });
});

describe('已读位置', () => {
  it('记住每个会话读到哪里', () => {
    markDmRead('dm:a', 100);
    markDmRead('dm:b', 200);
    expect(loadDmRead()).toEqual({ 'dm:a': 100, 'dm:b': 200 });
  });

  it('只前进不后退', () => {
    markDmRead('dm:a', 200);
    // Reconnecting replays the whole retained history, and its last message can be older
    // than what is already on screen; letting that move the mark back would bring the badge
    // for already-read messages straight back.
    markDmRead('dm:a', 100);
    expect(loadDmRead()['dm:a']).toBe(200);
  });

  it('存储被破坏时当作没读过，而不是抛异常', () => {
    // The sidebar is mounted for signed-out users too, and nothing on this path may throw.
    localStorage.setItem('dg-chat-dm-read', 'not json');
    expect(loadDmRead()).toEqual({});
  });
});
