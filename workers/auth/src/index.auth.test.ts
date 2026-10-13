import { beforeEach, describe, expect, it } from 'vitest';
import worker, { registrationConflict } from './index';
import {
  env,
  req,
  prepared,
  post,
  GOOD,
  registerUser,
  del,
  useAuthWorkerTestEnv,
} from './index.test-support';
import { createTestDb } from './test-helpers';
import { LEGAL_TERMS_VERSION } from '@0xnullai/auth/legal';

useAuthWorkerTestEnv(createTestDb);

// These tests reset the captured mail mid-test, so they own the array that the
// EMAIL binding writes to.
let sentEmails: unknown[];
beforeEach(() => {
  sentEmails = [];
  env.EMAIL = {
    send: async (message: unknown) => {
      sentEmails.push(message);
    },
  } as unknown as SendEmail;
});

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

  it.each([
    {
      name: '用户名不区分大小写地唯一',
      run: async () => {
        await registerUser();
        // Without this, Alice and alice would be two accounts and it would be anyone's
        // guess which one a login lands on.
        const { res } = await registerUser({ username: 'ALICE' });
        expect(res.status).toBe(409);
      },
    },
    {
      name: '接受 8 位密码并拒绝更短的密码',
      run: async () => {
        const tooShort = await registerUser({ password: '1234567' });
        expect(tooShort.res.status).toBe(400);
        expect(tooShort.body.error).toBe('密码至少 8 位');

        const minimum = await registerUser({ password: '12345678' });
        expect(minimum.res.status).toBe(201);
      },
    },
    {
      name: '需要有效且唯一的邮箱',
      run: async () => {
        const missing = await registerUser({ email: undefined });
        expect(missing.res.status).toBe(400);
        const invalid = await registerUser({ username: 'bob', email: 'bad' });
        expect(invalid.res.status).toBe(400);
        await registerUser();
        const duplicate = await registerUser({ username: 'bob', email: 'ALICE@example.com' });
        expect(duplicate.res.status).toBe(409);
      },
    },
  ])('$name', async ({ run }) => {
    await run();
  });

  it('要求同意当前版本的用户协议，并记录同意的版本', async () => {
    for (const acceptedTerms of [undefined, '', 'an-older-version', true]) {
      const { res, body } = await registerUser({ acceptedTerms });
      expect(res.status).toBe(400);
      expect(body.error).toBe('请更新到最新版本后注册');
    }
    expect(await prepared('SELECT COUNT(*) AS n FROM users').first()).toEqual({ n: 0 });

    const before = Date.now();
    const { res, body } = await registerUser();
    expect(res.status).toBe(201);
    const recorded = await prepared(
      'SELECT terms_version, accepted_at FROM legal_acceptances WHERE user_id = ?',
      body.user!.id,
    ).all<{ terms_version: string; accepted_at: number }>();
    expect(recorded.results).toEqual([
      { terms_version: LEGAL_TERMS_VERSION, accepted_at: expect.any(Number) as number },
    ]);
    expect(recorded.results[0]!.accepted_at).toBeGreaterThanOrEqual(before);
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

describe('登录设备管理', () => {
  it('列出当前设备并可退出其他会话', async () => {
    const first = await registerUser();
    const secondResponse = await worker.fetch(
      req('/api/auth/login', {
        method: 'POST',
        headers: { 'User-Agent': '0xNuller Windows' },
        body: JSON.stringify({ username: GOOD.username, password: GOOD.password }),
      }),
      env,
    );
    const second = (await secondResponse.json()) as { token: string };
    const list = await worker.fetch(req('/api/auth/sessions', { token: second.token }), env);
    const sessions = (await list.json()) as {
      sessions: { current: boolean; userAgent: string | null }[];
    };
    expect(sessions.sessions).toHaveLength(2);
    expect(sessions.sessions.filter((session) => session.current)).toHaveLength(1);
    expect(sessions.sessions.some((session) => session.userAgent === '0xNuller Windows')).toBe(
      true,
    );

    expect((await del('/api/auth/sessions/others', second.token)).status).toBe(200);
    expect((await worker.fetch(req('/api/auth/me', { token: first.body.token }), env)).status).toBe(
      200,
    );
    const oldMe = (await (
      await worker.fetch(req('/api/auth/me', { token: first.body.token }), env)
    ).json()) as { user: unknown };
    expect(oldMe.user).toBeNull();
    expect((await prepared('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>())?.n).toBe(
      1,
    );
  });
});

describe('平台语音票据', () => {
  it('只向登录账户签发短期语音票据', async () => {
    expect((await post('/api/auth/voice/ticket', {})).status).toBe(401);
    const { body } = await registerUser();
    const response = await worker.fetch(
      req('/api/auth/voice/ticket', { method: 'POST', token: body.token }),
      env,
    );
    expect(response.status).toBe(200);
    const issued = (await response.json()) as { ticket: string; expiresAt: number };
    expect(issued.ticket).toContain('.');
    expect(issued.expiresAt).toBeGreaterThan(Date.now());
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

  it('封禁结束已有会话，且只向持有正确密码者说明封禁原因', async () => {
    const { body } = await registerUser();
    const token = (body as { token: string }).token;
    expect((await worker.fetch(req('/api/auth/credits/balance', { token }), env)).status).toBe(200);
    await prepared(
      "UPDATE users SET banned_at = 1, ban_reason = 'secret-reason' WHERE username = ?",
      GOOD.username,
    ).run();
    expect((await worker.fetch(req('/api/auth/credits/balance', { token }), env)).status).toBe(401);
    expect(await (await worker.fetch(req('/api/auth/me', { token }), env)).json()).toEqual({
      user: null,
    });

    const wrongPass = await post('/api/auth/login', { ...GOOD, password: 'wrong-but-long-enough' });
    const noUser = await post('/api/auth/login', { username: 'bob', password: 'whatever-long' });
    expect(wrongPass.status).toBe(401);
    expect(await wrongPass.text()).toBe(await noUser.text());

    const right = await post('/api/auth/login', GOOD);
    expect(right.status).toBe(403);
    expect(await right.text()).toContain('secret-reason');
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

  // This performs 30 failed logins. To keep "no such user" and "wrong password"
  // indistinguishable by response time, a nonexistent user still runs a full
  // 210k-iteration PBKDF2 — 30 of those get close to vitest's default 5s timeout.
  // Give it enough time rather than weakening the production settings to make the
  // test run faster. Both IP checks share one 30-failure loop.
  it('换用户名继续撞库时按 IP 限流，另一个 IP 不受影响', { timeout: 30_000 }, async () => {
    await registerUser();
    for (let i = 0; i < 30; i++) {
      await post('/api/auth/login', { username: `user${i}`, password: 'wrong-but-long-enough' });
    }
    const res = await post('/api/auth/login', { username: 'user99', password: 'wrong-but-long' });
    expect(res.status).toBe(429);
    // A shared egress IP (campus network, NAT) is common, and one person credential
    // stuffing should not lock everyone on that network out. What this verifies is
    // that the IP dimension really buckets per IP instead of counting globally.
    const other = await post('/api/auth/login', GOOD, { ip: '9.9.9.9' });
    expect(other.status).toBe(200);
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
