import { describe, expect, it } from 'vitest';
import worker, { runAuthMaintenance, runPendingAccountDeletions } from './index';
import {
  env,
  photos,
  req,
  prepared,
  post,
  GOOD,
  registerUser,
  get,
  del,
  seedUser,
  useAuthWorkerTestEnv,
} from './index.test-support';
import { createTestDb } from './test-helpers';
import { verifyDmTicket } from './dm-ticket';

useAuthWorkerTestEnv(createTestDb);

describe('注销账号', () => {
  it('硬删除，且所有设备上的会话随之失效', async () => {
    const { body } = await registerUser();
    await prepared(
      "INSERT INTO push_registrations(installation_id,user_id,provider,platform,created_at,updated_at) SELECT 'firebase-installation-01',id,'fcm-fid','android',1,1 FROM users LIMIT 1",
    ).run();
    const second = await post('/api/auth/login', GOOD);
    const secondToken = ((await second.json()) as { token: string }).token;

    const del = await worker.fetch(
      req('/api/auth/account', { method: 'DELETE', token: body.token }),
      env,
    );
    expect(del.status).toBe(200);

    // Session invalidation itself is guaranteed by currentUser's `JOIN users` — with
    // the user gone there is nothing to join to. This assertion passes even with
    // foreign keys off, so what it proves is "safe", not "CASCADE works".
    const me = await worker.fetch(req('/api/auth/me', { token: secondToken }), env);
    expect(((await me.json()) as { user: unknown }).user).toBeNull();

    // CASCADE has to be verified separately: what it governs is whether the rows are
    // really deleted. If it fails, sessions accumulates orphan records pointing at
    // deleted users forever — account deletion becomes "looks deleted", and users in
    // this category are extremely sensitive about whether it is really gone.
    const orphans = await prepared('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>();
    expect(orphans?.n).toBe(0);
    expect(
      (await prepared('SELECT COUNT(*) AS n FROM push_registrations').first<{ n: number }>())?.n,
    ).toBe(0);

    // The username is released along with it and can be registered again.
    expect((await registerUser()).res.status).toBe(201);
  });

  it('未登录不能注销', async () => {
    const res = await worker.fetch(req('/api/auth/account', { method: 'DELETE' }), env);
    expect(res.status).toBe(401);
  });

  it('删除账号时清空整个相册前缀，包括没有 D1 行的孤儿', async () => {
    const alice = await seedUser('alice');
    for (const suffix of ['row-backed', 'orphan-a', 'orphan-b']) {
      await photos.put(`users/${alice.id}/photos/${suffix}`, new Uint8Array([1]).buffer);
    }
    await photos.put('users/someone-else/photos/keep', new Uint8Array([2]).buffer);
    await prepared(
      "INSERT INTO user_photos (id, user_id, object_key, visibility, created_at) VALUES (?, ?, ?, 'private', ?)",
      'p1',
      alice.id,
      `users/${alice.id}/photos/row-backed`,
      Date.now(),
    ).run();

    expect((await del('/api/auth/account', alice.token)).status).toBe(200);
    expect([...photos.objects.keys()]).toEqual(['users/someone-else/photos/keep']);
  });

  it('R2 暂时失败时立即冻结账号，并由 maintenance 完成删除', async () => {
    const alice = await seedUser('alice');
    await prepared(
      "INSERT INTO push_registrations(installation_id,user_id,provider,platform,created_at,updated_at) VALUES('firebase-installation-01',?,'fcm-fid','android',1,1)",
      alice.id,
    ).run();
    await photos.put(`users/${alice.id}/photos/retry`, new Uint8Array([1]).buffer);
    photos.failDeletes = 1;

    const response = await del('/api/auth/account', alice.token);
    expect(response.status).toBe(202);
    expect((await response.json()) as object).toEqual({ ok: false, pending: true });
    expect(
      (await prepared('SELECT COUNT(*) AS n FROM push_registrations').first<{ n: number }>())?.n,
    ).toBe(0);
    expect(await prepared('SELECT 1 FROM users WHERE id = ?', alice.id).first()).not.toBeNull();
    expect(
      await prepared('SELECT 1 FROM account_deletions WHERE user_id = ?', alice.id).first(),
    ).not.toBeNull();
    expect(
      ((await (await get('/api/auth/me', alice.token)).json()) as { user: unknown }).user,
    ).toBeNull();

    await runAuthMaintenance(env, Date.now());
    expect(await prepared('SELECT 1 FROM users WHERE id = ?', alice.id).first()).toBeNull();
    expect(photos.objects.size).toBe(0);
  });

  it('Chat 撤销未确认时保留删除任务及关系索引，重试确认后才硬删', async () => {
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');
    await prepared(
      'INSERT INTO user_chat_rooms(user_id,code,name,joined_at,updated_at) VALUES (?, ?, ?, ?, ?)',
      alice.id,
      'old-room',
      '旧群',
      Date.now(),
      Date.now(),
    ).run();
    await prepared(
      'INSERT INTO dm_threads(user_id,peer_id,started_at) VALUES (?, ?, ?)',
      alice.id,
      bob.id,
      Date.now(),
    ).run();
    const normalFetch = env.CHAT.fetch.bind(env.CHAT);
    const paths: string[] = [];
    let failGroup = true;
    env.CHAT = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        if (failGroup && path === '/api/groups/account-deletion/room')
          return new Response('unavailable', { status: 503 });
        return normalFetch(input, init);
      },
    } as unknown as Fetcher;

    const response = await del('/api/auth/account', alice.token);
    expect(response.status).toBe(202);
    expect(await prepared('SELECT 1 FROM users WHERE id = ?', alice.id).first()).not.toBeNull();
    expect(
      await prepared('SELECT 1 FROM account_deletions WHERE user_id = ?', alice.id).first(),
    ).not.toBeNull();
    expect(
      await prepared('SELECT 1 FROM dm_threads WHERE user_id = ?', alice.id).first(),
    ).not.toBeNull();
    expect(paths).not.toContain('/api/dm/revoke');

    failGroup = false;
    await runPendingAccountDeletions(env, Date.now());
    expect(await prepared('SELECT 1 FROM users WHERE id = ?', alice.id).first()).not.toBeNull();
    await runPendingAccountDeletions(env, Date.now() + 60_001);
    expect(paths).toContain('/api/groups/account-deletion/room');
    expect(paths).toContain('/api/dm/revoke');
    expect(await prepared('SELECT 1 FROM users WHERE id = ?', alice.id).first()).toBeNull();
  });

  it('无本地书签时仍遍历 Chat 权威群索引，全部确认后才删除账户', async () => {
    const alice = await seedUser('alice');
    const pending = new Set(['room-a', 'room-b']);
    const normalFetch = env.CHAT.fetch.bind(env.CHAT);
    const revoked: string[] = [];
    env.CHAT = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const body = JSON.parse(String(init?.body ?? '{}')) as { token: string; room?: string };
        const claims = await verifyDmTicket('test-dm-ticket-secret', body.token, Date.now());
        if (path === '/api/groups/account-deletion')
          return Response.json({
            accountId: claims?.sub,
            deletionId: claims?.deletionId,
            tombstoned: true,
            rooms: [...pending].slice(0, 1),
            nextCursor: null,
            coverage: 'registered-and-observed',
            legacyCoverage: 'unknown',
          });
        if (path === '/api/groups/account-deletion/room' && body.room) {
          pending.delete(body.room);
          revoked.push(body.room);
          return Response.json({ accountId: claims?.sub, room: body.room, revoked: true });
        }
        return normalFetch(input, init);
      },
    } as unknown as Fetcher;

    expect((await del('/api/auth/account', alice.token)).status).toBe(200);
    expect(revoked).toEqual(['room-a', 'room-b']);
    expect(pending.size).toBe(0);
    expect(await prepared('SELECT 1 FROM users WHERE id = ?', alice.id).first()).toBeNull();
  });
});
