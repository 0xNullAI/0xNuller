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
