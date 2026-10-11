import { describe, expect, it } from 'vitest';
import {
  prepared,
  post,
  get,
  del,
  seedUser,
  follow,
  block,
  listOf,
  useAuthWorkerTestEnv,
} from './index.test-support';
import { createTestDb } from './test-helpers';

useAuthWorkerTestEnv(createTestDb);

describe('关注', () => {
  it.each([
    { action: '关注', act: follow },
    { action: '拉黑', act: block },
  ])('不能$action自己', async ({ act }) => {
    const alice = await seedUser('alice');
    // Enforced on the server, not just hidden in the UI: the UI is not the only
    // caller. A stored self-follow would surface as the user showing up in their
    // own follower list, which reads as a broken product rather than a missing check.
    const res = await act(alice.token, alice.id);
    expect(res.status).toBe(400);
    expect(
      (await prepared('SELECT COUNT(*) AS n FROM user_follows').first<{ n: number }>())?.n,
    ).toBe(0);
  });

  it('关注是单向的，两边都关注才算联系人', async () => {
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');

    const first = await follow(alice.token, bob.id);
    expect(((await first.json()) as { mutual: boolean }).mutual).toBe(false);
    // Alice follows Bob, so Bob is in her following list — and she is in his
    // followers list, not his following list.
    expect(await listOf('/api/auth/following', alice.token)).toEqual(['bob']);
    expect(await listOf('/api/auth/followers', alice.token)).toEqual([]);
    expect(await listOf('/api/auth/followers', bob.token)).toEqual(['alice']);

    const back = await follow(bob.token, alice.id);
    expect(((await back.json()) as { mutual: boolean }).mutual).toBe(true);
    expect(await listOf('/api/auth/contacts', alice.token)).toEqual(['bob']);
    expect(await listOf('/api/auth/contacts', bob.token)).toEqual(['alice']);
  });

  it('可以移除粉丝而不取消自己的关注', async () => {
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');
    await follow(alice.token, bob.id);
    await follow(bob.token, alice.id);
    expect((await del(`/api/auth/follower/${bob.id}`, alice.token)).status).toBe(200);
    expect(await listOf('/api/auth/followers', alice.token)).toEqual([]);
    expect(await listOf('/api/auth/following', alice.token)).toEqual(['bob']);
  });

  it('重复关注不会产生第二行，取消关注是幂等的', async () => {
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');
    await follow(alice.token, bob.id);
    expect((await follow(alice.token, bob.id)).status).toBe(200);
    expect(
      (await prepared('SELECT COUNT(*) AS n FROM user_follows').first<{ n: number }>())?.n,
    ).toBe(1);
    expect((await del(`/api/auth/follow/${bob.id}`, alice.token)).status).toBe(200);
    // "I do not follow this person" is equally true the second time.
    expect((await del(`/api/auth/follow/${bob.id}`, alice.token)).status).toBe(200);
    expect(await listOf('/api/auth/following', alice.token)).toEqual([]);
  });

  it('未登录时列表与关注都拒绝', async () => {
    expect((await get('/api/auth/following')).status).toBe(401);
    expect((await get('/api/auth/followers')).status).toBe(401);
    expect((await post('/api/auth/follow', { userId: 'whoever' })).status).toBe(401);
  });

  it('分页大小有上限，要多少都不给超', async () => {
    const alice = await seedUser('alice');
    // One more than the cap, so an unclamped limit would visibly hand back the
    // lot. The cap is what keeps a single request from being a bulk export of
    // who is connected to whom.
    for (let i = 0; i <= 50; i++) {
      const u = await seedUser(`u${i}`);
      await follow(alice.token, u.id);
    }

    const res = await get('/api/auth/following?limit=999', alice.token);
    const body = (await res.json()) as { users: unknown[]; nextOffset: number | null };
    expect(body.users.length).toBe(50);
    expect(body.nextOffset).toBe(50);

    const rest = (await (
      await get('/api/auth/following?limit=50&offset=50', alice.token)
    ).json()) as { users: unknown[]; nextOffset: number | null };
    // A short page is the end of the list, and it is the only signal — there is
    // no total, because a follower count is a number people scrape.
    expect(rest.users.length).toBe(1);
    expect(rest.nextOffset).toBeNull();
  });
});

describe('拉黑', () => {
  it('被拉黑的人无法关注对方，且看不出自己被拉黑了', async () => {
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');
    await block(alice.token, bob.id);

    const blocked = await follow(bob.token, alice.id);
    const ghost = await follow(bob.token, 'id-nobody');
    expect(blocked.status).toBe(404);
    // Same status and same words as a user who does not exist. Confirming "you
    // have been blocked" tells someone exactly who to go after, and it would also
    // turn the block into a way to check whether an account still exists.
    expect(await blocked.text()).toBe(await ghost.text());
    expect(
      (await prepared('SELECT COUNT(*) AS n FROM user_follows').first<{ n: number }>())?.n,
    ).toBe(0);
  });

  it('拉黑会删掉两个方向上已有的关注', async () => {
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');
    await follow(alice.token, bob.id);
    await follow(bob.token, alice.id);

    await block(alice.token, bob.id);

    // A block that leaves the existing follows in place is not a block.
    expect(
      (await prepared('SELECT COUNT(*) AS n FROM user_follows').first<{ n: number }>())?.n,
    ).toBe(0);
    expect(await listOf('/api/auth/following', alice.token)).toEqual([]);
    expect(await listOf('/api/auth/followers', alice.token)).toEqual([]);
    expect(await listOf('/api/auth/followers', bob.token)).toEqual([]);
    expect(await listOf('/api/auth/following', bob.token)).toEqual([]);
  });

  it('拉黑双方彼此从列表里消失，即使关注行还在', async () => {
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');
    await follow(alice.token, bob.id);
    // Write the block straight to the table, skipping the endpoint that also
    // deletes the follows. This is the case the read-path filter exists for: one
    // future call site that blocks without cleaning up, and a blocked person is
    // back in someone's list with nothing to show it went wrong.
    await prepared(
      'INSERT INTO user_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)',
      bob.id,
      alice.id,
      Date.now(),
    ).run();

    expect(await listOf('/api/auth/following', alice.token)).toEqual([]);
    expect(await listOf('/api/auth/followers', bob.token)).toEqual([]);
  });

  it('解除拉黑不会把关注还回来', async () => {
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');
    await follow(alice.token, bob.id);
    await block(alice.token, bob.id);
    expect((await del(`/api/auth/block/${bob.id}`, alice.token)).status).toBe(200);

    // The follow was removed by a deliberate act; bringing it back silently would
    // be a worse surprise than having to follow again.
    expect(await listOf('/api/auth/following', alice.token)).toEqual([]);
    expect((await get('/api/auth/blocks', alice.token)).status).toBe(200);
    expect(await listOf('/api/auth/blocks', alice.token)).toEqual([]);
  });

  it('黑名单列出被自己拉黑的人', async () => {
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');
    await block(alice.token, bob.id);
    expect(await listOf('/api/auth/blocks', alice.token)).toEqual(['bob']);
    // Not the other way round: Bob is not told he is on a list.
    expect(await listOf('/api/auth/blocks', bob.token)).toEqual([]);
  });
});

describe('用户举报', () => {
  it('保存结构化举报并合并重复待处理记录', async () => {
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');
    const first = await post(
      '/api/auth/report',
      {
        userId: bob.id,
        reason: 'harassment',
        details: '持续发送骚扰信息',
      },
      { token: alice.token },
    );
    expect(first.status).toBe(201);
    const duplicate = await post(
      '/api/auth/report',
      {
        userId: bob.id,
        reason: 'spam',
      },
      { token: alice.token },
    );
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json()) as { duplicate: boolean }).toMatchObject({ duplicate: true });
    expect(
      (await prepared('SELECT COUNT(*) AS n FROM user_reports').first<{ n: number }>())?.n,
    ).toBe(1);
  });

  it('拒绝举报自己与无效原因', async () => {
    const alice = await seedUser('alice');
    expect(
      (await post('/api/auth/report', { userId: alice.id, reason: 'spam' }, { token: alice.token }))
        .status,
    ).toBe(400);
    expect(
      (
        await post(
          '/api/auth/report',
          { userId: 'nobody', reason: 'invented' },
          { token: alice.token },
        )
      ).status,
    ).toBe(400);
  });
});
