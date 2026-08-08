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

/** 直查库，用于断言接口之外的存储事实（token 未落原文、孤儿行已清）。 */
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
    // 不做这一步的话 Alice 和 alice 会是两个账号，登录时用谁都说不清。
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
    // 两者可区分就等于提供了用户名枚举接口。
    expect(await wrongPass.text()).toBe(await noUser.text());
    expect(wrongPass.status).toBe(noUser.status);
  });

  it('同一用户名连续失败到上限后限流', async () => {
    await registerUser();
    for (let i = 0; i < 8; i++) {
      await post('/api/auth/login', { ...GOOD, password: 'wrong-but-long-enough' });
    }
    // 关键点：限流之后连**正确**密码也必须被挡住，否则限流只是延缓而非阻断。
    const res = await post('/api/auth/login', GOOD);
    expect(res.status).toBe(429);
  });

  // 这两条各做 30 次失败登录。为了让「用户不存在」与「密码错误」的响应时间不可区分，
  // 用户不存在时也会走一遍 210k 轮 PBKDF2——30 次就逼近 vitest 默认的 5s 超时。
  // 给足时间，而不是为了测试跑得快去削弱生产配置。
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
    // 共用出口 IP（校园网、NAT）很常见，一个人撞库不该让同网段所有人登不上。
    // 这里验证的是 IP 维度确实按 IP 分桶，而不是全局计数。
    const res = await post('/api/auth/login', GOOD, { ip: '9.9.9.9' });
    expect(res.status).toBe(200);
  });
});

describe('会话', () => {
  it('token 以哈希形式入库，原文不落盘', async () => {
    const { body } = await registerUser();
    // 库里存的是 sha256(token)，用原文查不到——库泄露也无法直接冒用会话。
    expect(
      await prepared('SELECT * FROM sessions WHERE token_hash = ?', body.token).first(),
    ).toBeNull();
    // 但确实存了一行，否则上面那条会因为「表是空的」而假通过。
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

    // 会话失效本身由 currentUser 的 `JOIN users` 保证——用户没了就 join 不到。
    // 这条即使外键关掉也会过，所以它证明的是「安全」，不是「CASCADE 生效」。
    const me = await worker.fetch(req('/api/auth/me', { token: secondToken }), env);
    expect(((await me.json()) as { user: unknown }).user).toBeNull();

    // CASCADE 要单独验：它管的是行有没有被真正删掉。失效的话 sessions 会永久堆积
    // 指向已删用户的孤儿记录——注销账号就成了「看起来删了」，而这个品类的用户对
    // 「有没有真的删掉」极其敏感。
    const orphans = await prepared('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>();
    expect(orphans?.n).toBe(0);

    // 用户名随之释放，可以重新注册。
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
    // 漏了它，浏览器会在预检阶段拦掉安卓端的 Bearer 请求——表现是「请求根本没发出去」。
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });
});
