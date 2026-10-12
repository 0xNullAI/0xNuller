import { describe, expect, it } from 'vitest';
import worker, {
  claimMarketItemsForCredentials,
  marketItemAccessForCredentials,
  marketAccountIdentityForCredentials,
  marketAccountActiveForOwner,
  runAuthMaintenance,
} from './index';
import {
  env,
  photos,
  req,
  prepared,
  post,
  get,
  del,
  seedUser,
  follow,
  block,
  useAuthWorkerTestEnv,
} from './index.test-support';
import { createTestDb } from './test-helpers';
import { VALID_PNG } from './test-image';

useAuthWorkerTestEnv(createTestDb);

describe('他人主页的可见性', () => {
  const setVisibility = (token: string, visibility: 'public' | 'friends' | 'private') =>
    worker.fetch(
      req('/api/auth/profile', {
        method: 'PUT',
        token,
        body: JSON.stringify({ bio: '一句话', visibility }),
      }),
      env,
    );

  it('旧版私密选项不再隐藏登录用户的主页，关注数和加入时间也公开', async () => {
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');
    await setVisibility(bob.token, 'private');
    await follow(alice.token, bob.id);

    const res = await get('/api/auth/users/bob', alice.token);
    const body = (await res.json()) as {
      user: { username: string };
      profile: { bio: string; visibility: string };
      following: boolean;
      counts: unknown;
      createdAt: unknown;
      photos: unknown[];
    };
    expect(res.status).toBe(200);
    expect(body.user.username).toBe('bob');
    expect(body.following).toBe(true);
    expect(body.profile).toMatchObject({ bio: '一句话', visibility: 'public' });
    expect(body.counts).toEqual({ followers: 1, following: 0 });
    expect(body.createdAt).toEqual(expect.any(Number));
    expect(body.photos).toEqual([]);
  });

  it('数据库中原有私密资料可读，但旧私密相册仍不外泄', async () => {
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');
    await setVisibility(bob.token, 'public');
    await prepared(
      "UPDATE user_profiles SET visibility = 'private' WHERE user_id = ?",
      bob.id,
    ).run();
    await prepared(
      "INSERT INTO user_photos (id, user_id, object_key, visibility, created_at) VALUES (?, ?, ?, 'private', ?)",
      'old-private',
      bob.id,
      'r2/old-private',
      Date.now(),
    ).run();

    const response = await get('/api/auth/users/bob', alice.token);
    const body = (await response.json()) as {
      profile: { bio: string; visibility: string };
      photos: Array<{ id: string }>;
    };
    expect(response.status).toBe(200);
    expect(body.profile).toMatchObject({ bio: '一句话', visibility: 'public' });
    expect(body.photos).toEqual([]);
    expect((await get('/api/auth/photos/old-private/content', alice.token)).status).toBe(404);
  });

  it('未填写资料的新账号仍有公开主页', async () => {
    const alice = await seedUser('alice');
    await seedUser('bob');
    const body = (await (await get('/api/auth/users/bob', alice.token)).json()) as {
      profile: { bio: string | null; visibility: string; discoverable: boolean };
      counts: { followers: number; following: number };
    };
    expect(body.profile).toMatchObject({ bio: null, visibility: 'public', discoverable: true });
    expect(body.counts).toEqual({ followers: 0, following: 0 });
  });

  it('旧版好友选项不再限制主页资料，私聊仍由互关控制', async () => {
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');
    await setVisibility(bob.token, 'friends');
    await follow(alice.token, bob.id);
    expect(
      (await (await get('/api/auth/users/bob', alice.token)).json()) as {
        profile: { bio: string };
        followedBy: boolean;
      },
    ).toMatchObject({ profile: { bio: '一句话' }, followedBy: false });
    await follow(bob.token, alice.id);
    expect(
      (
        (await (await get('/api/auth/users/bob', alice.token)).json()) as {
          profile: { bio: string } | null;
        }
      ).profile?.bio,
    ).toBe('一句话');
  });

  it('迁移 0067 把旧版未开启发现的资料一起打开', async () => {
    const legacy = await seedUser('legacy');
    await prepared(
      `INSERT INTO user_profiles (user_id, links, interests, discoverable, visibility, updated_at)
       VALUES (?, '[]', '[]', 0, 'private', 1)`,
      legacy.id,
    ).run();
    const { readFileSync } = await import('node:fs');
    const sql = readFileSync(
      new URL('../migrations/0067_discoverable_by_default.sql', import.meta.url),
      'utf8',
    );
    await env.DB.prepare(sql.replace(/--.*$/gm, '').trim()).run();
    expect(
      await env.DB.prepare('SELECT discoverable FROM user_profiles WHERE user_id=?')
        .bind(legacy.id)
        .first(),
    ).toEqual({ discoverable: 1 });
  });

  it('发现默认包含账号，排除主动关闭发现、待删除和拉黑关系的账号', async () => {
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');
    const carol = await seedUser('carol');
    const dave = await seedUser('dave');
    const erin = await seedUser('erin');
    const save = (token: string, body: Record<string, unknown>) =>
      worker.fetch(
        req('/api/auth/profile', { method: 'PUT', token, body: JSON.stringify(body) }),
        env,
      );
    await save(bob.token, { bio: '不想被发现', discoverable: false });
    await save(carol.token, { bio: '默认开启', interests: ['音乐', '游戏'] });
    const before = (await (await get('/api/auth/discover', alice.token)).json()) as {
      users: Array<{ username: string; interests: string[] }>;
    };
    expect(before.users.map((user) => user.username).sort()).toEqual(['carol', 'dave', 'erin']);
    expect(before.users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ username: 'carol', interests: ['音乐', '游戏'] }),
        expect.objectContaining({ username: 'dave', bio: null, interests: [] }),
      ]),
    );
    expect(
      await env.DB.prepare('SELECT discoverable FROM user_profiles WHERE user_id=?')
        .bind(bob.id)
        .first(),
    ).toEqual({ discoverable: 0 });
    // Saving the profile again keeps the owner's choice instead of re-enabling discovery.
    await save(bob.token, { bio: '还是不想被发现', discoverable: false });
    await save(carol.token, { bio: '现在关闭', discoverable: false });
    await prepared(
      'INSERT INTO account_deletions(user_id, requested_at) VALUES (?, 1)',
      erin.id,
    ).run();
    await block(alice.token, dave.id);
    const after = (await (await get('/api/auth/discover', alice.token)).json()) as {
      users: unknown[];
    };
    expect(after.users).toEqual([]);
  });

  it('头像只能选择自己已经上传的账户图片', async () => {
    const bob = await seedUser('bob');
    const external = await worker.fetch(
      req('/api/auth/profile', {
        method: 'PUT',
        token: bob.token,
        body: JSON.stringify({ avatarUrl: 'https://tracker.example/avatar.png' }),
      }),
      env,
    );
    expect(external.status).toBe(400);

    const uploaded = await worker.fetch(
      req('/api/auth/photos', {
        method: 'POST',
        token: bob.token,
        headers: { 'content-type': 'image/png', 'x-photo-visibility': 'public' },
        body: VALID_PNG,
      }),
      env,
    );
    const photo = (await uploaded.json()) as { photo: { url: string } };
    const saved = await worker.fetch(
      req('/api/auth/profile', {
        method: 'PUT',
        token: bob.token,
        body: JSON.stringify({ avatarUrl: photo.photo.url, visibility: 'public' }),
      }),
      env,
    );
    expect(saved.status).toBe(200);
    const profile = (await (await get('/api/auth/profile', bob.token)).json()) as {
      profile: { avatarUrl: string };
    };
    expect(profile.profile.avatarUrl).toBe(photo.photo.url);
  });

  it('公开主页拒绝可执行链接，并过滤旧库里的异常链接', async () => {
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');
    const rejected = await worker.fetch(
      req('/api/auth/profile', {
        method: 'PUT',
        token: bob.token,
        body: JSON.stringify({ links: ['javascript:alert(1)'] }),
      }),
      env,
    );
    expect(rejected.status).toBe(400);
    const saved = await worker.fetch(
      req('/api/auth/profile', {
        method: 'PUT',
        token: bob.token,
        body: JSON.stringify({ links: ['https://example.com/about'] }),
      }),
      env,
    );
    expect(saved.status).toBe(200);
    await prepared('UPDATE user_profiles SET links=? WHERE user_id=?')
      .bind(JSON.stringify(['javascript:alert(1)', 'https://example.com/about']), bob.id)
      .run();
    const publicView = (await (await get('/api/auth/users/bob', alice.token)).json()) as {
      profile: { links: string[] };
    };
    expect(publicView.profile.links).toEqual(['https://example.com/about']);
  });

  it('公开资料也不把生日给别人看', async () => {
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');
    await worker.fetch(
      req('/api/auth/profile', {
        method: 'PUT',
        token: bob.token,
        body: JSON.stringify({ bio: '一句话', birthDate: '1990-01-01', visibility: 'public' }),
      }),
      env,
    );

    const mine = (await (await get('/api/auth/users/bob', bob.token)).json()) as {
      profile: { birthDate: string | null } | null;
    };
    const theirs = (await (await get('/api/auth/users/bob', alice.token)).json()) as {
      profile: { birthDate: string | null; bio: string } | null;
    };
    // The profile editor promises the exact date is not shown; making the profile
    // public is consent to the bio and the region, not to that. Bob still sees his
    // own.
    expect(mine.profile?.birthDate).toBe('1990-01-01');
    expect(theirs.profile?.bio).toBe('一句话');
    expect(theirs.profile?.birthDate).toBeNull();
  });

  it('自己的私密资料自己看得到，且仍然有关注数', async () => {
    const bob = await seedUser('bob');
    await setVisibility(bob.token, 'private');
    const body = (await (await get('/api/auth/users/bob', bob.token)).json()) as {
      profile: { bio: string } | null;
      counts: { followers: number; following: number } | null;
      createdAt: number | null;
    };
    expect(body.profile?.bio).toBe('一句话');
    expect(body.counts).toEqual({ followers: 0, following: 0 });
    expect(body.createdAt).toBeGreaterThan(0);
  });

  it('拉黑之后双方都查不到对方', async () => {
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');
    await setVisibility(bob.token, 'public');
    await setVisibility(alice.token, 'public');
    await block(alice.token, bob.id);

    // Symmetric on purpose: enforcing it one way only would leave the blocked
    // person free to keep watching the blocker, which is the situation blocking
    // exists to end.
    expect((await get('/api/auth/users/bob', alice.token)).status).toBe(404);
    expect((await get('/api/auth/users/alice', bob.token)).status).toBe(404);
  });

  it('公开资料带上关注数、加入时间与相册', async () => {
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');
    const carol = await seedUser('carol');
    await setVisibility(bob.token, 'public');
    await follow(alice.token, bob.id);
    await follow(carol.token, bob.id);
    await follow(bob.token, alice.id);

    const body = (await (await get('/api/auth/users/bob', alice.token)).json()) as {
      counts: { followers: number; following: number } | null;
      createdAt: number | null;
      photos: unknown[];
    };
    expect(body.counts).toEqual({ followers: 2, following: 1 });
    expect(body.createdAt).toBeGreaterThan(0);
    // No R2 bucket is bound, so there is no upload path and no rows to return.
    expect(body.photos).toEqual([]);
  });

  it('未登录不能读取主页、关注数或照片', async () => {
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');
    await setVisibility(bob.token, 'public');
    await follow(alice.token, bob.id);

    const response = await get('/api/auth/users/bob');
    expect(response.status).toBe(401);
    expect(JSON.stringify(await response.json())).not.toContain('followers');
    expect((await get('/api/auth/photos/unknown/content')).status).toBe(401);
  });

  it('相册对象缺失时取图片返回 404，而不是泄漏存储错误', async () => {
    const bob = await seedUser('bob');
    await setVisibility(bob.token, 'public');
    await prepared(
      "INSERT INTO user_photos (id, user_id, object_key, caption, visibility, created_at) VALUES (?, ?, ?, ?, 'public', ?)",
      'p1',
      bob.id,
      'r2/bucket-object-key',
      null,
      Date.now(),
    ).run();

    const listed = (await (await get('/api/auth/users/bob', bob.token)).json()) as {
      photos: { id: string; url: string }[];
    };
    expect(listed.photos).toHaveLength(1);
    // The R2 key must never reach the client; only the opaque id does.
    expect(JSON.stringify(listed.photos)).not.toContain('bucket-object-key');
    expect(listed.photos[0]?.url).toBe('/api/auth/photos/p1/content');

    expect((await get('/api/auth/photos/p1/content', bob.token)).status).toBe(404);
  });

  it('上传、读取、列出和删除照片形成完整的 D1 + R2 生命周期', async () => {
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');
    await setVisibility(bob.token, 'public');
    const uploaded = await worker.fetch(
      req('/api/auth/photos', {
        method: 'POST',
        token: bob.token,
        headers: {
          'content-type': 'image/png',
          'x-photo-caption': encodeURIComponent('一张测试图'),
          'x-photo-visibility': 'public',
        },
        body: VALID_PNG,
      }),
      env,
    );
    expect(uploaded.status).toBe(201);
    const photo = (await uploaded.json()) as {
      photo: { id: string; url: string; caption: string };
    };

    const ownList = (await (await get('/api/auth/photos', bob.token)).json()) as {
      photos: { id: string; url: string }[];
    };
    expect(ownList.photos).toEqual([
      expect.objectContaining({ id: photo.photo.id, url: photo.photo.url }),
    ]);
    expect(JSON.stringify(ownList)).not.toContain('users/');

    const content = await get(photo.photo.url, bob.token);
    expect(content.status).toBe(200);
    expect(content.headers.get('content-type')).toBe('image/png');
    expect(content.headers.get('cache-control')).toBe('private, no-store');
    expect([...new Uint8Array(await content.arrayBuffer())]).toEqual([...VALID_PNG]);

    const madePrivate = await worker.fetch(
      req(`/api/auth/photos/${photo.photo.id}`, {
        method: 'PATCH',
        token: bob.token,
        body: JSON.stringify({ visibility: 'private' }),
      }),
      env,
    );
    expect(madePrivate.status).toBe(200);
    expect((await get(photo.photo.url, alice.token)).status).toBe(404);
    expect((await get(photo.photo.url, bob.token)).status).toBe(200);

    expect((await del(`/api/auth/photos/${photo.photo.id}`, bob.token)).status).toBe(200);
    expect(photos.objects.size).toBe(0);
    expect((await get(photo.photo.url, bob.token)).status).toBe(404);
  });

  it('头像资源与相册分离', async () => {
    const bob = await seedUser('bob');
    const uploaded = await worker.fetch(
      req('/api/auth/photos', {
        method: 'POST',
        token: bob.token,
        headers: {
          'content-type': 'image/png',
          'x-photo-visibility': 'public',
          'x-photo-purpose': 'avatar',
        },
        body: VALID_PNG,
      }),
      env,
    );
    expect(uploaded.status).toBe(201);
    const ownList = (await (await get('/api/auth/photos', bob.token)).json()) as {
      photos: unknown[];
    };
    expect(ownList.photos).toEqual([]);
  });

  it('并发上传由唯一槽位约束在 60 张，而不是先 COUNT 再竞态写入', async () => {
    const bob = await seedUser('bob');
    const responses = await Promise.all(
      Array.from({ length: 61 }, () =>
        worker.fetch(
          req('/api/auth/photos', {
            method: 'POST',
            token: bob.token,
            headers: { 'content-type': 'image/png' },
            body: VALID_PNG,
          }),
          env,
        ),
      ),
    );
    expect(responses.filter((response) => response.status === 201)).toHaveLength(60);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(1);
    const rows = await prepared(
      'SELECT COUNT(*) AS n, COUNT(DISTINCT slot) AS slots FROM user_photos WHERE user_id = ?',
      bob.id,
    ).first<{ n: number; slots: number }>();
    expect(rows).toEqual({ n: 60, slots: 60 });
  });

  it('失败补偿也失败时保留 uploading 任务，maintenance 删除 R2 与行', async () => {
    const bob = await seedUser('bob');
    photos.failPuts = 1;
    photos.failDeletes = 1;
    const response = await worker.fetch(
      req('/api/auth/photos', {
        method: 'POST',
        token: bob.token,
        headers: { 'content-type': 'image/png' },
        body: VALID_PNG,
      }),
      env,
    );
    expect(response.status).toBe(500);
    const pending = await prepared(
      "SELECT id, object_key FROM user_photos WHERE user_id = ? AND status = 'uploading'",
      bob.id,
    ).first<{ id: string; object_key: string }>();
    expect(pending).not.toBeNull();

    await prepared('UPDATE user_photos SET created_at = 0 WHERE id = ?', pending!.id).run();
    await runAuthMaintenance(env, 2 * 60 * 60 * 1000);
    expect(
      await prepared('SELECT 1 FROM user_photos WHERE id = ?', pending!.id).first(),
    ).toBeNull();
  });

  it('公开 HTTP 不能直接写归属，Market 私有证明可写且 verified first-claim-wins', async () => {
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');
    expect(
      (await post('/api/auth/market-claims', { itemId: 'item-1' }, { token: alice.token })).status,
    ).toBe(405);

    await prepared(
      'INSERT INTO market_claims (item_id, user_id, claimed_at) VALUES (?, ?, ?)',
      'item-1',
      bob.id,
      1,
    ).run();
    const aliceProof = await claimMarketItemsForCredentials(
      env,
      { authorization: `Bearer ${alice.token}`, cookie: null },
      ['item-1'],
      'market-upload',
    );
    expect(aliceProof).toBe('ok');
    const bobProof = await claimMarketItemsForCredentials(
      env,
      { authorization: `Bearer ${bob.token}`, cookie: null },
      ['item-1'],
      'market-upload',
    );
    expect(bobProof).toBe('conflict');
    const claim = await prepared(
      'SELECT user_id, proof_method, verified_at FROM market_claims WHERE item_id = ?',
      'item-1',
    ).first<{ user_id: string; proof_method: string; verified_at: number }>();
    expect(claim?.user_id).toBe(alice.id);
    expect(claim?.proof_method).toBe('market-upload');
    expect(claim?.verified_at).toBeGreaterThan(0);

    await prepared(
      `INSERT INTO market_claims
         (item_id, user_id, claimed_at, verified_at, proof_method)
       VALUES (?, ?, ?, ?, ?)`,
      'item-conflict',
      bob.id,
      2,
      2,
      'market-edit-key',
    ).run();
    const batchConflict = await claimMarketItemsForCredentials(
      env,
      { authorization: `Bearer ${alice.token}`, cookie: null },
      ['item-free', 'item-conflict'],
      'market-upload',
    );
    expect(batchConflict).toBe('conflict');
    expect(
      await prepared('SELECT 1 FROM market_claims WHERE item_id = ?', 'item-free').first(),
    ).toBeNull();

    await expect(
      marketItemAccessForCredentials(
        env,
        { authorization: `Bearer ${alice.token}`, cookie: null },
        'item-1',
      ),
    ).resolves.toBe('owner');
    await expect(
      marketItemAccessForCredentials(
        env,
        { authorization: `Bearer ${bob.token}`, cookie: null },
        'item-1',
      ),
    ).resolves.toBe('user');
    await prepared("UPDATE users SET role = 'admin' WHERE id = ?", bob.id).run();
    await expect(
      marketItemAccessForCredentials(
        env,
        { authorization: `Bearer ${bob.token}`, cookie: null },
        'item-1',
      ),
    ).resolves.toBe('admin');
    await expect(
      marketItemAccessForCredentials(env, { authorization: null, cookie: null }, 'item-1'),
    ).resolves.toBe('unauthorized');
    await expect(
      marketAccountIdentityForCredentials(env, {
        authorization: `Bearer ${alice.token}`,
        cookie: null,
      }),
    ).resolves.toEqual({ id: alice.id });
    await expect(
      marketAccountIdentityForCredentials(env, { authorization: null, cookie: null }),
    ).resolves.toBeNull();
  });

  it('拒绝非图片与超过上限的图片，不写 R2', async () => {
    const bob = await seedUser('bob');
    const wrongType = await worker.fetch(
      req('/api/auth/photos', {
        method: 'POST',
        token: bob.token,
        headers: { 'content-type': 'text/html' },
        body: '<script></script>',
      }),
      env,
    );
    expect(wrongType.status).toBe(415);
    // MAX_PHOTO_BYTES in index.ts is 8 MiB.
    const tooLarge = await worker.fetch(
      req('/api/auth/photos', {
        method: 'POST',
        token: bob.token,
        headers: { 'content-type': 'image/png' },
        body: new Uint8Array(8 * 1024 * 1024 + 1),
      }),
      env,
    );
    expect(tooLarge.status).toBe(413);
    expect(photos.objects.size).toBe(0);
  });

  it('Market 私有附件回收能识别注销标记与已删除账户', async () => {
    const user = await seedUser('market_container_owner');
    await expect(marketAccountActiveForOwner(env, user.id)).resolves.toBe(true);
    await prepared(
      'INSERT INTO account_deletions(user_id,requested_at) VALUES(?,?)',
      user.id,
      Date.now(),
    ).run();
    await expect(marketAccountActiveForOwner(env, user.id)).resolves.toBe(false);
    await prepared('DELETE FROM users WHERE id=?', user.id).run();
    await expect(marketAccountActiveForOwner(env, user.id)).resolves.toBe(false);
    await expect(marketAccountActiveForOwner(env, '../other')).resolves.toBe(false);
  });

  it('旧私密主页里的公开照片对登录用户可见', async () => {
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');
    await setVisibility(bob.token, 'private');
    await prepared(
      "INSERT INTO user_photos (id, user_id, object_key, caption, visibility, created_at) VALUES (?, ?, ?, ?, 'public', ?)",
      'p1',
      bob.id,
      'r2/bucket-object-key',
      null,
      Date.now(),
    ).run();

    const body = (await (await get('/api/auth/users/bob', alice.token)).json()) as {
      photos: unknown[];
    };
    expect(body.photos).toEqual([expect.objectContaining({ id: 'p1' })]);
    // The missing R2 object still returns 404.
    expect((await get('/api/auth/photos/p1/content', alice.token)).status).toBe(404);
  });

  it('公开资料里的私密照片只有自己看得到', async () => {
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');
    await setVisibility(bob.token, 'public');
    await prepared(
      "INSERT INTO user_photos (id, user_id, object_key, caption, visibility, created_at) VALUES (?, ?, ?, ?, 'private', ?)",
      'p1',
      bob.id,
      'r2/bucket-object-key',
      null,
      Date.now(),
    ).run();

    const theirs = (await (await get('/api/auth/users/bob', alice.token)).json()) as {
      photos: unknown[];
    };
    expect(theirs.photos).toEqual([]);

    const mine = (await (await get('/api/auth/users/bob', bob.token)).json()) as {
      photos: { id: string }[];
    };
    expect(mine.photos.map((p) => p.id)).toEqual(['p1']);
  });
});
