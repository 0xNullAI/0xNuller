import { describe, expect, it } from 'vitest';
import worker from './index';
import {
  ORIGIN,
  env,
  sentEmails,
  req,
  prepared,
  registerUser,
  useAuthWorkerTestEnv,
} from './index.test-support';
import { createTestDb } from './test-helpers';

useAuthWorkerTestEnv(createTestDb);

describe('feedback', () => {
  it('stores anonymous feedback and forwards it by email', async () => {
    const res = await worker.fetch(
      req('/api/auth/feedback', {
        method: 'POST',
        body: JSON.stringify({ message: '安卓连接窗口需要帮助', contact: 'tester@example.com' }),
      }),
      env,
    );

    expect(res.status).toBe(201);
    const row = await prepared(
      'SELECT user_id, contact, message, ip_hash FROM feedback LIMIT 1',
    ).first<Record<string, unknown>>();
    expect(row).toMatchObject({
      user_id: null,
      contact: 'tester@example.com',
      message: '安卓连接窗口需要帮助',
    });
    expect(String(row?.ip_hash)).not.toContain('1.2.3.4');
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]).toMatchObject({ to: 'leonardoshen@icloud.com' });
  });

  it('rejects empty feedback', async () => {
    const res = await worker.fetch(
      req('/api/auth/feedback', { method: 'POST', body: JSON.stringify({ message: '   ' }) }),
      env,
    );
    expect(res.status).toBe(400);
    expect(sentEmails).toHaveLength(0);
  });

  it('limits one address to five submissions per hour', async () => {
    for (let index = 0; index < 5; index += 1) {
      const res = await worker.fetch(
        req('/api/auth/feedback', {
          method: 'POST',
          body: JSON.stringify({ message: `反馈 ${index}` }),
        }),
        env,
      );
      expect(res.status).toBe(201);
    }
    const limited = await worker.fetch(
      req('/api/auth/feedback', {
        method: 'POST',
        body: JSON.stringify({ message: '第六条' }),
      }),
      env,
    );
    expect(limited.status).toBe(429);
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
      creditUsedToday: 0,
      creditPurchasedToday: 0,
    });
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
