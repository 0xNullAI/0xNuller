import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker, { type Env } from './index';
import { createTestDb } from './test-helpers';

const ORIGIN = 'https://0xnullai.com';
let db: ReturnType<typeof createTestDb>;
let env: Env;

beforeEach(() => {
  db = createTestDb();
  env = { DB: db.DB as Env['DB'], IP_PEPPER: 'test-pepper', ALLOWED_ORIGINS: ORIGIN };
});
afterEach(() => db.close());

function req(path: string, init: RequestInit & { ip?: string; token?: string } = {}) {
  const { ip = '1.2.3.4', token, ...rest } = init;
  return new Request(`https://auth.0xnullai.com${path}`, {
    ...rest,
    headers: {
      'content-type': 'application/json',
      Origin: ORIGIN,
      'CF-Connecting-IP': ip,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...rest.headers,
    },
  });
}

/**
 * Query the database directly, to assert storage facts the API does not expose (the
 * token is not stored in the clear, orphan rows are gone).
 */
function prepared(sql: string, ...args: unknown[]) {
  const stmt = env.DB.prepare(sql);
  return args.length ? stmt.bind(...args) : stmt;
}

const post = (path: string, body: unknown, extra = {}) =>
  worker.fetch(req(path, { method: 'POST', body: JSON.stringify(body), ...extra }), env);

const GOOD = { username: 'alice', password: 'correct-horse-battery' };

async function registerUser(overrides: Record<string, unknown> = {}) {
  const res = await post('/api/auth/register', { ...GOOD, ...overrides });
  return {
    res,
    body: (await res.json()) as { user?: { id: string }; token?: string; error?: string },
  };
}

describe('注册', () => {
  it('建号后立刻是已登录状态', async () => {
    const { res, body } = await registerUser();
    expect(res.status).toBe(201);
    expect(body.token).toBeTruthy();

    const me = await worker.fetch(req('/api/auth/me', { token: body.token }), env);
    expect(((await me.json()) as { user: { username: string } }).user.username).toBe('alice');
  });

  it('用户名不区分大小写地唯一', async () => {
    await registerUser();
    // Without this, Alice and alice would be two accounts and it would be anyone's
    // guess which one a login lands on.
    const { res } = await registerUser({ username: 'ALICE' });
    expect(res.status).toBe(409);
  });

  it('拒绝过短的密码', async () => {
    const { res } = await registerUser({ password: 'short' });
    expect(res.status).toBe(400);
  });

  it('不需要邮箱', async () => {
    const { res } = await registerUser();
    expect(res.status).toBe(201);
  });
});

describe('登录', () => {
  it('密码正确时签发新会话', async () => {
    await registerUser();
    const res = await post('/api/auth/login', GOOD);
    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie')).toContain('HttpOnly');
  });

  it('用户不存在与密码错误返回同一句话', async () => {
    await registerUser();
    const wrongPass = await post('/api/auth/login', { ...GOOD, password: 'wrong-but-long-enough' });
    const noUser = await post('/api/auth/login', { username: 'bob', password: 'whatever-long' });
    // If the two are distinguishable, we have shipped a username enumeration API.
    expect(await wrongPass.text()).toBe(await noUser.text());
    expect(wrongPass.status).toBe(noUser.status);
  });

  it('同一用户名连续失败到上限后限流', async () => {
    await registerUser();
    for (let i = 0; i < 8; i++) {
      await post('/api/auth/login', { ...GOOD, password: 'wrong-but-long-enough' });
    }
    // The key point: once rate limited, even the **correct** password must be
    // blocked, otherwise the limit only slows an attack down instead of stopping it.
    const res = await post('/api/auth/login', GOOD);
    expect(res.status).toBe(429);
  });

  // These two each perform 30 failed logins. To keep "no such user" and "wrong
  // password" indistinguishable by response time, a nonexistent user still runs a
  // full 210k-iteration PBKDF2 — 30 of those get close to vitest's default 5s
  // timeout. Give them enough time rather than weakening the production settings to
  // make the tests run faster.
  it('换用户名继续撞库时按 IP 限流', { timeout: 30_000 }, async () => {
    for (let i = 0; i < 30; i++) {
      await post('/api/auth/login', { username: `user${i}`, password: 'wrong-but-long-enough' });
    }
    const res = await post('/api/auth/login', { username: 'user99', password: 'wrong-but-long' });
    expect(res.status).toBe(429);
  });

  it('另一个 IP 不受该用户名之外的限流影响', { timeout: 30_000 }, async () => {
    await registerUser();
    for (let i = 0; i < 30; i++) {
      await post('/api/auth/login', { username: `user${i}`, password: 'wrong-but-long-enough' });
    }
    // A shared egress IP (campus network, NAT) is common, and one person credential
    // stuffing should not lock everyone on that network out. What this verifies is
    // that the IP dimension really buckets per IP instead of counting globally.
    const res = await post('/api/auth/login', GOOD, { ip: '9.9.9.9' });
    expect(res.status).toBe(200);
  });
});

describe('会话', () => {
  it('token 以哈希形式入库，原文不落盘', async () => {
    const { body } = await registerUser();
    // What is stored is sha256(token), so the clear text finds nothing — a database
    // leak still cannot be used to impersonate a session directly.
    expect(
      await prepared('SELECT * FROM sessions WHERE token_hash = ?', body.token).first(),
    ).toBeNull();
    // But a row really was written, otherwise the assertion above would pass falsely
    // just because the table is empty.
    expect((await prepared('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>())?.n).toBe(
      1,
    );
  });

  it('登出后 token 立即失效', async () => {
    const { body } = await registerUser();
    await worker.fetch(req('/api/auth/logout', { method: 'POST', token: body.token }), env);
    const me = await worker.fetch(req('/api/auth/me', { token: body.token }), env);
    expect(((await me.json()) as { user: unknown }).user).toBeNull();
  });

  it('cookie 与 Bearer 两种载体都认', async () => {
    const { body } = await registerUser();
    const viaCookie = await worker.fetch(
      req('/api/auth/me', { headers: { Cookie: `0xn_session=${body.token}` } }),
      env,
    );
    expect(((await viaCookie.json()) as { user: unknown }).user).not.toBeNull();
  });

  it('无凭据时返回 null 而不是报错', async () => {
    const res = await worker.fetch(req('/api/auth/me'), env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: unknown }).user).toBeNull();
  });
});

describe('注销账号', () => {
  it('硬删除，且所有设备上的会话随之失效', async () => {
    const { body } = await registerUser();
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

    // The username is released along with it and can be registered again.
    expect((await registerUser()).res.status).toBe(201);
  });

  it('未登录不能注销', async () => {
    const res = await worker.fetch(req('/api/auth/account', { method: 'DELETE' }), env);
    expect(res.status).toBe(401);
  });
});

// ── Contacts ──

const get = (path: string, token?: string) => worker.fetch(req(path, { token }), env);
const del = (path: string, token?: string) =>
  worker.fetch(req(path, { method: 'DELETE', token }), env);

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Create a user and a live session directly in the database.
 *
 * Registration runs a 210k-iteration PBKDF2 every time, and these cases need
 * two or three users each — going through the API would spend most of the
 * suite's runtime hashing passwords no assertion ever looks at. What is under
 * test here is the follow graph, and it only needs the rows to exist.
 */
async function seedUser(username: string) {
  const id = `id-${username}`;
  const token = `token-${username}`;
  await prepared(
    'INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
    id,
    username,
    username,
    'unused',
    Date.now(),
  ).run();
  await prepared(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    await sha256Hex(token),
    id,
    Date.now(),
    Date.now() + 86_400_000,
  ).run();
  return { id, username, token };
}

const follow = (token: string, userId: string) => post('/api/auth/follow', { userId }, { token });
const block = (token: string, userId: string) => post('/api/auth/block', { userId }, { token });

async function listOf(path: string, token: string): Promise<string[]> {
  const res = await get(path, token);
  const body = (await res.json()) as { users: { username: string }[] };
  return body.users.map((u) => u.username);
}

describe('关注', () => {
  it('不能关注自己', async () => {
    const alice = await seedUser('alice');
    // Enforced on the server, not just hidden in the UI: the UI is not the only
    // caller. A stored self-follow would surface as the user showing up in their
    // own follower list, which reads as a broken product rather than a missing check.
    const res = await follow(alice.token, alice.id);
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
  });

  it('重复关注不会产生第二行', async () => {
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');
    await follow(alice.token, bob.id);
    expect((await follow(alice.token, bob.id)).status).toBe(200);
    expect(
      (await prepared('SELECT COUNT(*) AS n FROM user_follows').first<{ n: number }>())?.n,
    ).toBe(1);
  });

  it('取消关注是幂等的', async () => {
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');
    await follow(alice.token, bob.id);
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

  it('不能拉黑自己', async () => {
    const alice = await seedUser('alice');
    expect((await block(alice.token, alice.id)).status).toBe(400);
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

describe('他人主页的可见性', () => {
  const setVisibility = (token: string, visibility: 'public' | 'private') =>
    worker.fetch(
      req('/api/auth/profile', {
        method: 'PUT',
        token,
        body: JSON.stringify({ bio: '一句话', visibility }),
      }),
      env,
    );

  it('私密资料对任何人都不可见——关注了也一样', async () => {
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');
    await setVisibility(bob.token, 'private');
    await follow(alice.token, bob.id);

    const res = await get('/api/auth/users/bob', alice.token);
    const body = (await res.json()) as {
      user: { username: string };
      profile: unknown;
      following: boolean;
    };
    expect(res.status).toBe(200);
    // The identity stays visible — it is the username Alice just typed, and
    // without it there is no way to confirm she found the right person. The
    // profile body does not, and following is not a way to earn it.
    expect(body.user.username).toBe('bob');
    expect(body.following).toBe(true);
    expect(body.profile).toBeNull();
  });

  it('公开资料对他人可见', async () => {
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');
    await setVisibility(bob.token, 'public');
    const body = (await (await get('/api/auth/users/bob', alice.token)).json()) as {
      profile: { bio: string } | null;
    };
    expect(body.profile?.bio).toBe('一句话');
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

  it('自己的私密资料自己看得到', async () => {
    const bob = await seedUser('bob');
    await setVisibility(bob.token, 'private');
    const body = (await (await get('/api/auth/users/bob', bob.token)).json()) as {
      profile: { bio: string } | null;
    };
    expect(body.profile?.bio).toBe('一句话');
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

  it('未登录也能看公开资料，但看不到关系', async () => {
    const bob = await seedUser('bob');
    await setVisibility(bob.token, 'public');
    // The account is optional throughout the product, so an anonymous reader is
    // not an error case here.
    const body = (await (await get('/api/auth/users/bob')).json()) as {
      profile: { bio: string } | null;
      following: boolean;
      followedBy: boolean;
    };
    expect(body.profile?.bio).toBe('一句话');
    expect(body.following).toBe(false);
    expect(body.followedBy).toBe(false);
  });
});

describe('CORS', () => {
  it('只对白名单来源回显 origin', async () => {
    const ok = await worker.fetch(req('/api/auth/me'), env);
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);

    const evil = await worker.fetch(
      new Request('https://auth.0xnullai.com/api/auth/me', {
        headers: { Origin: 'https://evil.com' },
      }),
      env,
    );
    expect(evil.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('预检放行 Authorization 头', async () => {
    const res = await worker.fetch(req('/api/auth/me', { method: 'OPTIONS' }), env);
    // Leave it out and the browser blocks the Android side's Bearer requests at the
    // preflight stage — the symptom being "the request never even went out".
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });
});
