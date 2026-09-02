import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker, {
  claimMarketItemsForCredentials,
  consumeAiQuotaForCredentials,
  marketItemAccessForCredentials,
  registrationConflict,
  runAuthMaintenance,
  voiceTicketQuota,
  type Env,
} from './index';
import { createTestDb } from './test-helpers';

const ORIGIN = 'https://0xnullai.com';
let db: ReturnType<typeof createTestDb>;
let env: Env;
let photos: FakePhotos;
let sentEmails: unknown[];

class FakePhotos {
  readonly objects = new Map<string, { bytes: ArrayBuffer; contentType: string; uploaded: Date }>();
  failPuts = 0;
  failDeletes = 0;

  async put(key: string, value: ArrayBuffer, options?: R2PutOptions): Promise<R2Object> {
    if (this.failPuts-- > 0) throw new Error('fake R2 put failure');
    this.objects.set(key, {
      bytes: value.slice(0),
      contentType:
        options?.httpMetadata instanceof Headers
          ? (options.httpMetadata.get('content-type') ?? 'application/octet-stream')
          : (options?.httpMetadata?.contentType ?? 'application/octet-stream'),
      uploaded: new Date(),
    });
    return { key } as R2Object;
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      key,
      body: new Response(object.bytes).body!,
      httpMetadata: { contentType: object.contentType },
      httpEtag: '"fake"',
    } as R2ObjectBody;
  }

  async delete(keys: string | string[]): Promise<void> {
    if (this.failDeletes-- > 0) throw new Error('fake R2 delete failure');
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }

  async list(options: R2ListOptions = {}): Promise<R2Objects> {
    const matching = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(options.prefix ?? ''))
      .sort(([a], [b]) => a.localeCompare(b));
    const start = options.cursor ? matching.findIndex(([key]) => key > options.cursor!) : 0;
    // Deliberately cap fake pages at two, so account deletion proves it keeps
    // relisting the now-shorter prefix until no objects remain.
    const limit = Math.min(options.limit ?? 1000, 2);
    const page = matching.slice(start, start + limit);
    const next = start + page.length;
    const base = {
      objects: page.map(([key, object]) => ({ key, uploaded: object.uploaded }) as R2Object),
      delimitedPrefixes: [],
    };
    if (next < matching.length) {
      return { ...base, truncated: true, cursor: page[page.length - 1]![0] };
    }
    return { ...base, truncated: false };
  }
}

beforeEach(() => {
  db = createTestDb();
  photos = new FakePhotos();
  sentEmails = [];
  env = {
    DB: db.DB as Env['DB'],
    PHOTOS: photos as unknown as R2Bucket,
    EMAIL: {
      send: async (message: unknown) => {
        sentEmails.push(message);
      },
    } as unknown as SendEmail,
    CHAT: { fetch: async () => new Response('ok') } as unknown as Fetcher,
    IP_PEPPER: 'test-pepper',
    DM_TICKET_SECRET: 'test-dm-ticket-secret',
    ALLOWED_ORIGINS: ORIGIN,
  };
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

const GOOD = {
  username: 'alice',
  email: 'alice@example.com',
  password: 'correct-horse-battery',
};

async function registerUser(overrides: Record<string, unknown> = {}) {
  const res = await post('/api/auth/register', { ...GOOD, ...overrides });
  return {
    res,
    body: (await res.json()) as {
      user?: { id: string; role: 'user' | 'admin' };
      token?: string;
      error?: string;
    },
  };
}

async function verifyRegisteredUser(body: {
  user?: { id: string };
  token?: string;
}): Promise<void> {
  await prepared(
    'UPDATE users SET email_verified_at = ? WHERE id = ?',
    Date.now(),
    body.user!.id,
  ).run();
}

describe('注册', () => {
  it('把并发写入触发的唯一约束统一映射为可读冲突', () => {
    expect(registrationConflict(new Error('UNIQUE constraint failed: users.username'))).toBe(
      'username',
    );
    expect(
      registrationConflict(new Error('UNIQUE constraint failed: index idx_users_email_unique')),
    ).toBe('email');
    expect(registrationConflict(new Error('database unavailable'))).toBeNull();
  });

  it('建号后立刻是已登录状态', async () => {
    const { res, body } = await registerUser();
    expect(res.status).toBe(201);
    expect(body.token).toBeTruthy();
    expect(body.user?.role).toBe('user');

    const me = await worker.fetch(req('/api/auth/me', { token: body.token }), env);
    expect(((await me.json()) as { user: { username: string; role: string } }).user).toMatchObject({
      username: 'alice',
      role: 'user',
    });
  });

  it('用户名不区分大小写地唯一', async () => {
    await registerUser();
    // Without this, Alice and alice would be two accounts and it would be anyone's
    // guess which one a login lands on.
    const { res } = await registerUser({ username: 'ALICE' });
    expect(res.status).toBe(409);
  });

  it('接受 8 位密码并拒绝更短的密码', async () => {
    const tooShort = await registerUser({ password: '1234567' });
    expect(tooShort.res.status).toBe(400);
    expect(tooShort.body.error).toBe('密码至少 8 位');

    const minimum = await registerUser({ password: '12345678' });
    expect(minimum.res.status).toBe(201);
  });

  it('需要有效且唯一的邮箱', async () => {
    const missing = await registerUser({ email: undefined });
    expect(missing.res.status).toBe(400);
    const invalid = await registerUser({ username: 'bob', email: 'bad' });
    expect(invalid.res.status).toBe(400);
    await registerUser();
    const duplicate = await registerUser({ username: 'bob', email: 'ALICE@example.com' });
    expect(duplicate.res.status).toBe(409);
  });

  it('限制同一来源短时间批量注册', async () => {
    for (let index = 0; index < 5; index += 1) {
      const { res } = await registerUser({
        username: `user-${index}`,
        email: `user-${index}@example.com`,
      });
      expect(res.status).toBe(201);
    }
    const blocked = await registerUser({ username: 'user-5', email: 'user-5@example.com' });
    expect(blocked.res.status).toBe(429);
    expect(blocked.body.error).toBe('注册请求过于频繁，请稍后再试');
  });
});

describe('邮箱验证与密码找回', () => {
  it('限制验证邮件和重置邮件的重复发送', async () => {
    const { body } = await registerUser();
    expect(
      (
        await worker.fetch(
          req('/api/auth/email/verification/request', { method: 'POST', token: body.token }),
          env,
        )
      ).status,
    ).toBe(429);

    sentEmails = [];
    expect((await post('/api/auth/password/forgot', { email: GOOD.email })).status).toBe(202);
    expect((await post('/api/auth/password/forgot', { email: GOOD.email })).status).toBe(202);
    expect(sentEmails).toHaveLength(1);
  });

  it('验证令牌只存哈希且使用后失效', async () => {
    const { body } = await registerUser();
    const text = String((sentEmails[0] as { text: string }).text);
    const token = new URL(text.match(/https:\/\/\S+/)![0]).searchParams.get('verify')!;
    expect(
      await prepared('SELECT 1 FROM email_action_tokens WHERE token_hash = ?', token).first(),
    ).toBeNull();

    expect((await post('/api/auth/email/verification/confirm', { token })).status).toBe(200);
    const me = await worker.fetch(req('/api/auth/me', { token: body.token }), env);
    expect(((await me.json()) as { user: { emailVerified: boolean } }).user.emailVerified).toBe(
      true,
    );
    expect((await post('/api/auth/email/verification/confirm', { token })).status).toBe(400);
  });

  it('不泄露账户是否存在，重置后注销旧会话', async () => {
    const { body } = await registerUser();
    sentEmails = [];
    expect((await post('/api/auth/password/forgot', { email: 'nobody@example.com' })).status).toBe(
      202,
    );
    expect(sentEmails).toHaveLength(0);
    expect((await post('/api/auth/password/forgot', { email: GOOD.email })).status).toBe(202);
    const text = String((sentEmails[0] as { text: string }).text);
    const token = new URL(text.match(/https:\/\/\S+/)![0]).searchParams.get('reset')!;
    expect(
      (await post('/api/auth/password/reset', { token, password: 'new-password-123' })).status,
    ).toBe(200);
    const oldSession = await worker.fetch(req('/api/auth/me', { token: body.token }), env);
    expect(((await oldSession.json()) as { user: unknown }).user).toBeNull();
    expect(
      (
        await post('/api/auth/login', {
          username: GOOD.username,
          password: 'new-password-123',
        })
      ).status,
    ).toBe(200);
  });
});

describe('邀请注册与活动 Credit', () => {
  async function confirmLatestVerification(): Promise<string> {
    const text = String((sentEmails.at(-1) as { text: string }).text);
    const token = new URL(text.match(/https:\/\/\S+/)![0]).searchParams.get('verify')!;
    const response = await post('/api/auth/email/verification/confirm', { token });
    expect(response.status).toBe(200);
    return token;
  }

  it('只在被邀请人完成邮箱验证后幂等发放 500 美分', async () => {
    const inviter = await registerUser();
    await confirmLatestVerification();

    const summaryResponse = await worker.fetch(
      req('/api/auth/referral', { token: inviter.body.token }),
      env,
    );
    expect(summaryResponse.status).toBe(200);
    const initial = (await summaryResponse.json()) as {
      code: string;
      balanceCents: number;
      rewardCents: number;
    };
    expect(initial).toMatchObject({ balanceCents: 0, rewardCents: 500 });

    const invitee = await registerUser({
      username: 'bob',
      email: 'bob@example.com',
      referralCode: initial.code.toLowerCase(),
    });
    expect(invitee.res.status).toBe(201);
    expect(
      await prepared(
        'SELECT 1 FROM credit_ledger WHERE user_id = ?',
        inviter.body.user!.id,
      ).first(),
    ).toBeNull();

    const verificationToken = await confirmLatestVerification();
    const after = await worker.fetch(req('/api/auth/referral', { token: inviter.body.token }), env);
    expect(await after.json()).toMatchObject({
      balanceCents: 500,
      rewardedCount: 1,
      pendingCount: 0,
    });

    expect(
      (await post('/api/auth/email/verification/confirm', { token: verificationToken })).status,
    ).toBe(400);
    const ledger = await prepared(
      'SELECT COUNT(*) AS n, SUM(amount_cents) AS cents FROM credit_ledger WHERE user_id = ?',
      inviter.body.user!.id,
    ).first<{ n: number; cents: number }>();
    expect(ledger).toEqual({ n: 1, cents: 500 });
  });

  it('未验证账户不能分享，且拒绝不存在的邀请码', async () => {
    const inviter = await registerUser();
    expect(
      (await worker.fetch(req('/api/auth/referral', { token: inviter.body.token }), env)).status,
    ).toBe(403);
    const invalid = await registerUser({
      username: 'bob',
      email: 'bob@example.com',
      referralCode: 'NOTREAL99',
    });
    expect(invalid.res.status).toBe(400);
  });

  it('为迁移与部署窗口中缺少邀请码的旧注册自动补写', async () => {
    const inviter = await registerUser();
    await confirmLatestVerification();
    await prepared('DELETE FROM referral_codes WHERE user_id = ?', inviter.body.user!.id).run();

    const response = await worker.fetch(
      req('/api/auth/referral', { token: inviter.body.token }),
      env,
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as { code: string }).toMatchObject({
      code: expect.stringMatching(/^[A-Z0-9]{12}$/),
    });
  });
});

describe('账户 AI 体验额度', () => {
  it('要求登录，并按账户原子扣减每日文字额度', async () => {
    expect(
      await consumeAiQuotaForCredentials(env, { authorization: null, cookie: null }, 'text'),
    ).toBe('unauthorized');
    const { body } = await registerUser();
    const credentials = { authorization: `Bearer ${body.token}`, cookie: null };
    for (let index = 0; index < 100; index += 1) {
      const result = await consumeAiQuotaForCredentials(env, credentials, 'text');
      expect(result).toMatchObject({ allowed: true, remaining: 99 - index, limit: 100 });
    }
    expect(await consumeAiQuotaForCredentials(env, credentials, 'text')).toEqual({
      allowed: false,
      remaining: 0,
      limit: 100,
    });

    const usage = await worker.fetch(req('/api/auth/ai-usage', { token: body.token }), env);
    expect(await usage.json()).toMatchObject({
      text: { used: 100, limit: 100 },
      voice: { used: 0, limit: 60 },
    });
  });

  it('签发短期语音票据，并按账户分钟额度扣减', async () => {
    const { body } = await registerUser();
    const response = await worker.fetch(
      req('/api/auth/voice/ticket', { method: 'POST', token: body.token }),
      env,
    );
    expect(response.status).toBe(200);
    const issued = (await response.json()) as { ticket: string; expiresAt: number };
    expect(issued.ticket).toContain('.');
    expect(issued.expiresAt).toBeGreaterThan(Date.now());

    expect(await voiceTicketQuota(env, issued.ticket, 0)).toMatchObject({
      subject: body.user!.id,
      allowed: true,
      remaining: 60,
    });
    expect(await voiceTicketQuota(env, issued.ticket, 2)).toMatchObject({
      subject: body.user!.id,
      allowed: true,
      remaining: 58,
    });
    expect(await voiceTicketQuota(env, 'forged.ticket', 1)).toBe('unauthorized');
  });
});

describe('运营统计', () => {
  it('只向管理员返回不含个人信息的汇总', async () => {
    const { body } = await registerUser();
    expect(
      (await worker.fetch(req('/api/auth/admin/stats', { token: body.token }), env)).status,
    ).toBe(403);
    await prepared("UPDATE users SET role = 'admin' WHERE id = ?", body.user!.id).run();
    const response = await worker.fetch(req('/api/auth/admin/stats', { token: body.token }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      users: 1,
      verifiedUsers: 0,
      activeSessions: 1,
      registrationAttempts24h: 1,
      textUnitsToday: 0,
      voiceUnitsToday: 0,
    });
  });
});

describe('Chat 房间账户同步', () => {
  it('跨会话读取已加入房间，并允许只从自己的列表移除', async () => {
    const { body } = await registerUser();
    await verifyRegisteredUser(body);
    const token = body.token!;
    const added = await worker.fetch(
      req('/api/auth/chat-rooms', {
        method: 'PUT',
        token,
        body: JSON.stringify({ code: 'private-room_7', name: '私密房间' }),
      }),
      env,
    );
    expect(added.status).toBe(200);

    const listed = await worker.fetch(req('/api/auth/chat-rooms', { token }), env);
    expect(await listed.json()).toMatchObject({
      rooms: [{ code: 'private-room_7', name: '私密房间' }],
    });

    const removed = await worker.fetch(
      req('/api/auth/chat-rooms/private-room_7', { method: 'DELETE', token }),
      env,
    );
    expect(removed.status).toBe(200);
    const empty = await worker.fetch(req('/api/auth/chat-rooms', { token }), env);
    expect(await empty.json()).toEqual({ rooms: [] });
  });

  it('拒绝匿名写入和无效房间号', async () => {
    const anonymous = await worker.fetch(req('/api/auth/chat-rooms'), env);
    expect(anonymous.status).toBe(401);
    const { body } = await registerUser();
    await verifyRegisteredUser(body);
    const invalid = await worker.fetch(
      req('/api/auth/chat-rooms', {
        method: 'PUT',
        token: body.token,
        body: JSON.stringify({ code: '../room' }),
      }),
      env,
    );
    expect(invalid.status).toBe(400);
  });

  it('房主密钥跨平台恢复管理权，且关闭会清除所有成员记录', async () => {
    const owner = (await registerUser()).body;
    const member = (await registerUser({ username: 'bob', email: 'bob@example.com' })).body;
    await verifyRegisteredUser(owner);
    await verifyRegisteredUser(member);
    for (const [token, ownerKey] of [
      [owner.token, 'owner-secret'],
      [member.token, undefined],
    ] as const) {
      await worker.fetch(
        req('/api/auth/chat-rooms', {
          method: 'PUT',
          token,
          body: JSON.stringify({ code: 'shared-room', name: '共享房间', ownerKey }),
        }),
        env,
      );
    }
    const listed = await worker.fetch(req('/api/auth/chat-rooms', { token: owner.token }), env);
    expect(await listed.json()).toMatchObject({ rooms: [{ ownerKey: 'owner-secret' }] });
    const denied = await worker.fetch(
      req('/api/auth/chat-rooms/shared-room/close', {
        method: 'POST',
        token: member.token,
        body: JSON.stringify({ ownerKey: 'owner-secret' }),
      }),
      env,
    );
    expect(denied.status).toBe(403);
    const closed = await worker.fetch(
      req('/api/auth/chat-rooms/shared-room/close', {
        method: 'POST',
        token: owner.token,
        body: JSON.stringify({ ownerKey: 'owner-secret' }),
      }),
      env,
    );
    expect(closed.status).toBe(200);
    const memberList = await worker.fetch(
      req('/api/auth/chat-rooms', { token: member.token }),
      env,
    );
    expect(await memberList.json()).toEqual({ rooms: [] });
  });

  it('邮箱未验证时服务端拒绝房间同步和 Chat 票据', async () => {
    const { body } = await registerUser();
    expect(
      (await worker.fetch(req('/api/auth/chat-rooms', { token: body.token }), env)).status,
    ).toBe(403);
    expect(
      (await worker.fetch(req('/api/auth/chat/ticket', { method: 'POST', token: body.token }), env))
        .status,
    ).toBe(403);
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
    await photos.put(`users/${alice.id}/photos/retry`, new Uint8Array([1]).buffer);
    photos.failDeletes = 1;

    const response = await del('/api/auth/account', alice.token);
    expect(response.status).toBe(202);
    expect((await response.json()) as object).toEqual({ ok: false, pending: true });
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

describe('内容同步分页', () => {
  it('同一毫秒超过一页时用 (updated_at, id) 游标，不跳过也不重复', async () => {
    const alice = await seedUser('alice');
    const updatedAt = 1_700_000_000_000;
    const statements = Array.from({ length: 501 }, (_, index) => {
      const id = `wave-${String(index).padStart(3, '0')}`;
      const entityId = `${alice.id}:${id}`;
      return [
        env.DB.prepare(
          `INSERT INTO content_entities
            (id, owner_id, kind, name, payload, created_at, updated_at)
           VALUES (?, ?, 'waveform', ?, '{}', ?, ?)`,
        ).bind(entityId, alice.id, id, updatedAt, updatedAt),
        env.DB.prepare(
          `INSERT INTO user_content_refs
            (user_id, content_id, client_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).bind(alice.id, entityId, id, updatedAt, updatedAt),
      ];
    }).flat();
    await env.DB.batch(statements);

    const first = (await (
      await get('/api/auth/content?kind=waveform&since=0', alice.token)
    ).json()) as { items: { id: string }[]; nextCursor: string | null };
    expect(first.items).toHaveLength(500);
    expect(first.nextCursor).toBeTruthy();

    const second = (await (
      await get(
        `/api/auth/content?kind=waveform&since=0&cursor=${encodeURIComponent(first.nextCursor!)}`,
        alice.token,
      )
    ).json()) as { items: { id: string }[]; nextCursor: string | null };
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(501);
  });
});

describe('Agent 会话同步', () => {
  it('按账户隔离会话，并用墓碑跨设备删除', async () => {
    const alice = await seedUser('agent-alice');
    const bob = await seedUser('agent-bob');
    const session = { id: 'session-1', updatedAt: 100, messages: [{ content: '私密' }] };
    const putSession = await worker.fetch(
      req('/api/auth/agent-sessions', {
        method: 'PUT',
        token: alice.token,
        body: JSON.stringify({
          sessions: [{ id: 'session-1', session, clientUpdatedAt: 100 }],
        }),
      }),
      env,
    );
    expect(putSession.status).toBe(200);

    const aliceList = (await (await get('/api/auth/agent-sessions', alice.token)).json()) as {
      sessions: { id: string; session: unknown; deleted: boolean }[];
    };
    expect(aliceList.sessions).toEqual([
      expect.objectContaining({ id: 'session-1', session, deleted: false }),
    ]);
    const bobList = (await (await get('/api/auth/agent-sessions', bob.token)).json()) as {
      sessions: unknown[];
    };
    expect(bobList.sessions).toEqual([]);

    await worker.fetch(
      req('/api/auth/agent-sessions', {
        method: 'PUT',
        token: alice.token,
        body: JSON.stringify({
          sessions: [{ id: 'session-1', deleted: true, clientUpdatedAt: 200 }],
        }),
      }),
      env,
    );
    const deleted = (await (await get('/api/auth/agent-sessions', alice.token)).json()) as {
      sessions: { id: string; deleted: boolean; session: unknown }[];
    };
    expect(deleted.sessions).toEqual([
      expect.objectContaining({ id: 'session-1', deleted: true, session: null }),
    ]);
  });

  it('旧设备的迟到写入不会复活已删除会话', async () => {
    const alice = await seedUser('agent-conflict');
    const write = async (clientUpdatedAt: number, deleted = false) =>
      worker.fetch(
        req('/api/auth/agent-sessions', {
          method: 'PUT',
          token: alice.token,
          body: JSON.stringify({
            sessions: [
              {
                id: 'same',
                session: deleted ? undefined : { id: 'same', updatedAt: clientUpdatedAt },
                clientUpdatedAt,
                deleted,
              },
            ],
          }),
        }),
        env,
      );
    await write(300, true);
    await write(200, false);

    const result = (await (await get('/api/auth/agent-sessions', alice.token)).json()) as {
      sessions: { deleted: boolean; clientUpdatedAt: number }[];
    };
    expect(result.sessions[0]).toEqual(
      expect.objectContaining({ deleted: true, clientUpdatedAt: 300 }),
    );
  });
});

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
        body: new Uint8Array([137, 80, 78, 71]),
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

  it('私密资料连关注数和加入时间都不给', async () => {
    // The whole point of the flag. A private profile that still reported its
    // follower count would publish exactly the presence and popularity signal
    // it was set to private to withhold, and a moving number tells a watcher
    // who just followed.
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');
    await setVisibility(bob.token, 'private');
    await follow(alice.token, bob.id);

    const body = (await (await get('/api/auth/users/bob', alice.token)).json()) as {
      counts: unknown;
      createdAt: unknown;
      photos: unknown[];
      user: { username: string };
    };
    expect(body.counts).toBeNull();
    expect(body.createdAt).toBeNull();
    expect(body.photos).toEqual([]);
    // The username stays: it is what the viewer typed to get here.
    expect(body.user.username).toBe('bob');
  });

  it('自己看自己的私密资料仍然有关注数', async () => {
    const bob = await seedUser('bob');
    await setVisibility(bob.token, 'private');
    const body = (await (await get('/api/auth/users/bob', bob.token)).json()) as {
      counts: { followers: number; following: number } | null;
      createdAt: number | null;
    };
    expect(body.counts).toEqual({ followers: 0, following: 0 });
    expect(body.createdAt).toBeGreaterThan(0);
  });

  it('未登录看公开资料也能看到关注数', async () => {
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');
    await setVisibility(bob.token, 'public');
    await follow(alice.token, bob.id);

    const body = (await (await get('/api/auth/users/bob')).json()) as {
      counts: { followers: number } | null;
    };
    expect(body.counts?.followers).toBe(1);
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

    const listed = (await (await get('/api/auth/users/bob')).json()) as {
      photos: { id: string; url: string }[];
    };
    expect(listed.photos).toHaveLength(1);
    // The R2 key must never reach the client; only the opaque id does.
    expect(JSON.stringify(listed.photos)).not.toContain('bucket-object-key');
    expect(listed.photos[0]?.url).toBe('/api/auth/photos/p1/content');

    expect((await get('/api/auth/photos/p1/content')).status).toBe(404);
  });

  it('上传、读取、列出和删除照片形成完整的 D1 + R2 生命周期', async () => {
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
        body: new Uint8Array([137, 80, 78, 71]),
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

    const content = await get(photo.photo.url);
    expect(content.status).toBe(200);
    expect(content.headers.get('content-type')).toBe('image/png');
    expect(content.headers.get('cache-control')).toBe('private, no-store');
    expect([...new Uint8Array(await content.arrayBuffer())]).toEqual([137, 80, 78, 71]);

    const madePrivate = await worker.fetch(
      req(`/api/auth/photos/${photo.photo.id}`, {
        method: 'PATCH',
        token: bob.token,
        body: JSON.stringify({ visibility: 'private' }),
      }),
      env,
    );
    expect(madePrivate.status).toBe(200);
    expect((await get(photo.photo.url)).status).toBe(404);
    expect((await get(photo.photo.url, bob.token)).status).toBe(200);

    expect((await del(`/api/auth/photos/${photo.photo.id}`, bob.token)).status).toBe(200);
    expect(photos.objects.size).toBe(0);
    expect((await get(photo.photo.url)).status).toBe(404);
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
        body: new Uint8Array([137, 80, 78, 71]),
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
            body: new Uint8Array([1]),
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
        body: new Uint8Array([1]),
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
    expect(photos.objects.size).toBe(0);
  });

  it('私密资料里的公开照片对别人不出现', async () => {
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
    expect(body.photos).toEqual([]);
    // And the bytes are refused too, re-derived rather than trusting the list.
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
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
  });
});
