import { describe, expect, it } from 'vitest';
import {
  GROUP_MESSAGE_LIMIT,
  canAdministerGroup,
  enforceMessageRetention,
  generateOwnerKey,
  hashOwnerKey,
  orphanMediaIds,
  type MediaStore,
  type MessageStore,
  type RetainedMessage,
} from './group';

/**
 * A room used to delete itself ten minutes after the last member left, which made both of
 * these problems somebody else's: history could not grow without bound because it did not
 * survive, and ownership did not have to outlive a peerId because neither did the room.
 * Groups are permanent now, so retention and ownership are the two rules holding the whole
 * thing up — and the two places a bug is expensive (a leaked R2 object nobody can reach, or
 * a stranger reconfiguring somebody's group).
 */

/** In-memory stand-in for the DO's `messages` table, oldest first. */
function fakeMessages(initial: RetainedMessage[]): MessageStore & { rows: RetainedMessage[] } {
  const rows = [...initial];
  return {
    rows,
    count: () => rows.length,
    oldest: (n) => rows.slice(0, n),
    remove: (ids) => {
      for (const id of ids) {
        const i = rows.findIndex((r) => r.id === id);
        if (i >= 0) rows.splice(i, 1);
      }
    },
  };
}

function fakeMedia(): MediaStore & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    delete: async (ids) => {
      deleted.push(...ids);
    },
  };
}

function message(id: string, mediaId: string | null = null): RetainedMessage {
  return { id, mediaId };
}

describe('群消息保留上限', () => {
  it('未超上限时什么都不删', async () => {
    const messages = fakeMessages([message('a'), message('b')]);
    const media = fakeMedia();
    expect(await enforceMessageRetention(messages, media, 5)).toEqual([]);
    expect(messages.rows).toHaveLength(2);
    expect(media.deleted).toEqual([]);
  });

  it('刚好等于上限也不删——上限是保留数量，不是触发阈值', async () => {
    const messages = fakeMessages([message('a'), message('b'), message('c')]);
    expect(await enforceMessageRetention(messages, fakeMedia(), 3)).toEqual([]);
    expect(messages.rows).toHaveLength(3);
  });

  it('超出时从最旧的开始删，删到正好等于上限', async () => {
    const messages = fakeMessages(['a', 'b', 'c', 'd', 'e'].map((id) => message(id)));
    const dropped = await enforceMessageRetention(messages, fakeMedia(), 2);
    expect(dropped).toEqual(['a', 'b', 'c']);
    expect(messages.rows.map((r) => r.id)).toEqual(['d', 'e']);
  });

  it('被删消息的 R2 媒体和行一起删——留下的孤儿没人能读到也没人会去删', async () => {
    const messages = fakeMessages([
      message('a', 'img-a'),
      message('b'),
      message('c', 'img-c'),
      message('d', 'img-d'),
    ]);
    const media = fakeMedia();
    await enforceMessageRetention(messages, media, 1);
    expect(media.deleted).toEqual(['img-a', 'img-c']);
    // 保留下来的那条的媒体绝不能被牵连删掉
    expect(media.deleted).not.toContain('img-d');
    expect(messages.rows.map((r) => r.id)).toEqual(['d']);
  });

  it('R2 删除失败时行留着，下一条消息再试——反过来会丢掉指向对象的唯一指针', async () => {
    const messages = fakeMessages([message('a', 'img-a'), message('b'), message('c')]);
    const media: MediaStore = {
      delete: async () => {
        throw new Error('R2 down');
      },
    };
    await expect(enforceMessageRetention(messages, media, 1)).rejects.toThrow('R2 down');
    expect(messages.rows).toHaveLength(3);
  });

  it('默认上限是有限的正整数', () => {
    expect(Number.isInteger(GROUP_MESSAGE_LIMIT)).toBe(true);
    expect(GROUP_MESSAGE_LIMIT).toBeGreaterThan(0);
  });
});

describe('孤儿媒体清扫', () => {
  const OLD = 1_000;
  const NEW = 9_000;

  it('删掉没有任何消息引用、且已经不新的对象', () => {
    const objects = [
      { id: 'orphan', uploadedAt: OLD },
      { id: 'kept', uploadedAt: OLD },
    ];
    expect(orphanMediaIds(objects, new Set(['kept']), 5_000)).toEqual(['orphan']);
  });

  it('刚上传的不动——它的聊天消息可能还在路上', () => {
    const objects = [{ id: 'just-uploaded', uploadedAt: NEW }];
    expect(orphanMediaIds(objects, new Set(), 5_000)).toEqual([]);
  });

  it('被引用的对象无论多旧都不删', () => {
    const objects = [{ id: 'referenced', uploadedAt: 0 }];
    expect(orphanMediaIds(objects, new Set(['referenced']), 5_000)).toEqual([]);
  });
});

describe('群主身份', () => {
  const CODE = 'abc123';

  it('拿着密钥的人才是群主', async () => {
    const key = generateOwnerKey();
    const ownerKeyHash = await hashOwnerKey(CODE, key);
    await expect(
      canAdministerGroup({
        code: CODE,
        ownerKeyHash,
        presentedKey: key,
        senderPeerId: 'anyone',
        hostPeerId: null,
      }),
    ).resolves.toBe(true);
  });

  it('密钥不对、缺失或不是字符串都不算', async () => {
    const ownerKeyHash = await hashOwnerKey(CODE, generateOwnerKey());
    for (const presentedKey of [generateOwnerKey(), '', undefined, null, 42, { key: 'x' }]) {
      await expect(
        canAdministerGroup({
          code: CODE,
          ownerKeyHash,
          presentedKey,
          senderPeerId: 'peer-1',
          hostPeerId: 'peer-1',
        }),
      ).resolves.toBe(false);
    }
  });

  it('有群主之后，房主身份（host）不再是权限——peerId 只活一个会话，群不是', async () => {
    const ownerKeyHash = await hashOwnerKey(CODE, generateOwnerKey());
    await expect(
      canAdministerGroup({
        code: CODE,
        ownerKeyHash,
        presentedKey: undefined,
        senderPeerId: 'host-peer',
        hostPeerId: 'host-peer',
      }),
    ).resolves.toBe(false);
  });

  it('同一把密钥换个群不成立——群号是盐', async () => {
    const key = generateOwnerKey();
    const ownerKeyHash = await hashOwnerKey('other-group', key);
    await expect(
      canAdministerGroup({
        code: CODE,
        ownerKeyHash,
        presentedKey: key,
        senderPeerId: 'peer-1',
        hostPeerId: null,
      }),
    ).resolves.toBe(false);
  });

  it('没有群主的老群回落到 host，老客户端不至于被自己建的房间锁在门外', async () => {
    await expect(
      canAdministerGroup({
        code: CODE,
        ownerKeyHash: null,
        presentedKey: undefined,
        senderPeerId: 'host-peer',
        hostPeerId: 'host-peer',
      }),
    ).resolves.toBe(true);
    await expect(
      canAdministerGroup({
        code: CODE,
        ownerKeyHash: null,
        presentedKey: undefined,
        senderPeerId: 'other-peer',
        hostPeerId: 'host-peer',
      }),
    ).resolves.toBe(false);
  });

  it('没有群主也没有 host 时谁都不行——空 peerId 不能匹配空 host', async () => {
    await expect(
      canAdministerGroup({
        code: CODE,
        ownerKeyHash: null,
        presentedKey: undefined,
        senderPeerId: '',
        hostPeerId: '',
      }),
    ).resolves.toBe(false);
    await expect(
      canAdministerGroup({
        code: CODE,
        ownerKeyHash: null,
        presentedKey: undefined,
        senderPeerId: '',
        hostPeerId: null,
      }),
    ).resolves.toBe(false);
  });

  it('密钥是随机的，且服务端只存哈希', async () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateOwnerKey()));
    expect(keys.size).toBe(50);
    const key = generateOwnerKey();
    const hash = await hashOwnerKey(CODE, key);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(key);
  });
});
