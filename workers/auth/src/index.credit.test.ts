import { describe, expect, it } from 'vitest';
import worker, {
  creditBalance,
  releaseCredits,
  reserveCredits,
  settleCredits,
  tipMarketItemForCredentials,
} from './index';
import {
  env,
  sentEmails,
  req,
  prepared,
  post,
  registerUser,
  seedUser,
  useAuthWorkerTestEnv,
} from './index.test-support';
import { createTestDb } from './test-helpers';

useAuthWorkerTestEnv(createTestDb);

describe('邀请注册与活动 Credit', () => {
  async function confirmLatestVerification(): Promise<string> {
    const text = String((sentEmails.at(-1) as { text: string }).text);
    const token = new URL(text.match(/https:\/\/\S+/)![0]).searchParams.get('verify')!;
    const response = await post('/api/auth/email/verification/confirm', { token });
    expect(response.status).toBe(200);
    return token;
  }

  it('只在被邀请人完成邮箱验证后幂等发放 500 Credit', async () => {
    const inviter = await registerUser();
    await confirmLatestVerification();

    const summaryResponse = await worker.fetch(
      req('/api/auth/referral', { token: inviter.body.token }),
      env,
    );
    expect(summaryResponse.status).toBe(200);
    const initial = (await summaryResponse.json()) as {
      code: string;
      balanceCredits: number;
      rewardCredits: number;
    };
    // The inviter's own verification already paid the one-time welcome Credit.
    expect(initial).toMatchObject({ balanceCredits: 100, rewardCredits: 500 });

    const invitee = await registerUser({
      username: 'bob',
      email: 'bob@example.com',
      referralCode: initial.code.toLowerCase(),
    });
    expect(invitee.res.status).toBe(201);
    expect(
      await prepared(
        "SELECT 1 FROM credit_ledger WHERE user_id = ? AND kind = 'referral_reward'",
        inviter.body.user!.id,
      ).first(),
    ).toBeNull();

    const verificationToken = await confirmLatestVerification();
    const after = await worker.fetch(req('/api/auth/referral', { token: inviter.body.token }), env);
    expect(await after.json()).toMatchObject({
      balanceCredits: 600,
      rewardedCount: 1,
      pendingCount: 0,
      activity: [expect.objectContaining({ status: 'rewarded', rewardCredits: 500 })],
    });

    expect(
      (await post('/api/auth/email/verification/confirm', { token: verificationToken })).status,
    ).toBe(400);
    const ledger = await prepared(
      "SELECT COUNT(*) AS n, SUM(amount_credits) AS cents FROM credit_ledger WHERE user_id = ? AND kind = 'referral_reward'",
      inviter.body.user!.id,
    ).first<{ n: number; cents: number }>();
    expect(ledger).toEqual({ n: 1, cents: 500 });
  });

  it('新账号只在邮箱验证后获得一次 100 Credit 体验额度', async () => {
    const user = await registerUser();
    const id = user.body.user!.id;
    const welcome = () =>
      prepared(
        "SELECT COUNT(*) AS n, SUM(amount_credits) AS credits FROM credit_ledger WHERE user_id = ? AND kind = 'admin_gift' AND reference_id = 'welcome'",
        id,
      ).first<{ n: number; credits: number | null }>();
    // Registering alone earns nothing: a flood of accounts without mailboxes gets no Credit.
    expect(await welcome()).toEqual({ n: 0, credits: null });
    const token = await confirmLatestVerification();
    expect(await welcome()).toEqual({ n: 1, credits: 100 });
    // A replayed link is refused and pays nothing more.
    expect((await post('/api/auth/email/verification/confirm', { token })).status).toBe(400);
    expect(await welcome()).toEqual({ n: 1, credits: 100 });
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

describe('Credit 账本与人工充值', () => {
  it('并发打赏不能透支或单独增加作者Credit，并尊重活跃预留', async () => {
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');
    await prepared(
      "INSERT INTO market_claims(item_id,user_id,claimed_at,verified_at) VALUES ('tip-item',?,1,1)",
      bob.id,
    ).run();
    await prepared(
      "INSERT INTO credit_ledger(user_id,amount_credits,kind,reference_id,price_version,created_at) VALUES (?,100,'support_adjustment','tip-seed','test',1)",
      alice.id,
    ).run();
    await reserveCredits(env, alice.id, {
      idempotencyKey: 'tip:held:voice',
      usageKind: 'voice',
      modelId: 'voice',
      credits: 20,
    });
    const credentials = { authorization: `Bearer ${alice.token}`, cookie: null };
    const result = await Promise.all([
      tipMarketItemForCredentials(env, credentials, 'tip-item', 60),
      tipMarketItemForCredentials(env, credentials, 'tip-item', 60),
    ]);
    expect(result.sort()).toEqual(['invalid', 'ok']);
    expect(await creditBalance(env, alice.id)).toMatchObject({
      total: 40,
      reserved: 20,
      available: 20,
    });
    expect(await creditBalance(env, bob.id)).toMatchObject({ total: 60 });
    expect(
      await prepared(
        "SELECT SUM(amount_credits) AS net,COUNT(*) AS n FROM credit_ledger WHERE kind='market_tip'",
      ).first(),
    ).toEqual({ net: 0, n: 2 });
  });

  it('释放先于结算事务时不会扣费或谎报 settled', async () => {
    const { body } = await registerUser();
    const userId = body.user!.id;
    await prepared(
      "INSERT INTO credit_ledger(user_id,amount_credits,kind,reference_id,price_version,created_at) VALUES (?,1000,'support_adjustment','race-seed','test',?)",
      userId,
      Date.now(),
    ).run();
    await reserveCredits(env, userId, {
      idempotencyKey: 'race:release-first',
      usageKind: 'agent',
      modelId: 'test/model',
      credits: 100,
    });
    const original = env.DB.batch.bind(env.DB);
    env.DB.batch = async (statements) => {
      await releaseCredits(env, userId, 'race:release-first');
      return original(statements);
    };
    try {
      expect(await settleCredits(env, userId, 'race:release-first', 30, {})).toMatchObject({
        status: 'released',
        charged: null,
        total: 1000,
      });
      expect(
        await prepared(
          "SELECT COUNT(*) AS n FROM credit_ledger WHERE kind='usage' AND user_id=?",
          userId,
        ).first(),
      ).toEqual({ n: 0 });
    } finally {
      env.DB.batch = original;
    }
  });

  it('冻结并按实际费用结算，同一幂等键只扣一次', async () => {
    const { body } = await registerUser();
    await prepared(
      `INSERT INTO credit_ledger
       (user_id, amount_credits, kind, reference_id, price_version, created_at)
       VALUES (?, 1000, 'support_adjustment', 'test-seed', 'test', ?)`,
      body.user!.id,
      Date.now(),
    ).run();

    const input = {
      idempotencyKey: 'request:credit:one',
      usageKind: 'agent' as const,
      modelId: 'test/model',
      credits: 100,
    };
    expect(await reserveCredits(env, body.user!.id, input)).toMatchObject({
      allowed: true,
      available: 900,
      reserved: 100,
    });
    expect(await reserveCredits(env, body.user!.id, input)).toMatchObject({
      allowed: false,
      available: 900,
      reserved: 100,
    });

    expect(
      await settleCredits(env, body.user!.id, input.idempotencyKey, 30, {
        model: input.modelId,
      }),
    ).toMatchObject({ status: 'settled', charged: 30, total: 970, reserved: 0 });
    expect(
      await settleCredits(env, body.user!.id, input.idempotencyKey, 30, {
        model: input.modelId,
      }),
    ).toMatchObject({ status: 'settled', charged: 30, total: 970 });
    expect(
      await prepared(
        "SELECT COUNT(*) AS n FROM credit_ledger WHERE kind = 'usage' AND reference_id = ?",
        input.idempotencyKey,
      ).first<{ n: number }>(),
    ).toEqual({ n: 1 });
  });

  it('拒绝非整数或非有限的 Credit 预留而不写入冻结记录', async () => {
    const { body } = await registerUser();
    for (const [index, credits] of [1.5, Number.NaN, Number.POSITIVE_INFINITY].entries()) {
      const key = `request:invalid-credit:${index}`;
      expect(
        await reserveCredits(env, body.user!.id, {
          idempotencyKey: key,
          usageKind: 'agent',
          modelId: 'test/model',
          credits,
        }),
      ).toMatchObject({ allowed: false, charged: null });
      expect(
        await prepared('SELECT idempotency_key FROM credit_reservations WHERE idempotency_key=?')
          .bind(key)
          .first(),
      ).toBeNull();
    }
  });

  it('释放失败请求的冻结额度，并拒绝余额不足的请求', async () => {
    const { body } = await registerUser();
    await prepared(
      `INSERT INTO credit_ledger
       (user_id, amount_credits, kind, reference_id, price_version, created_at)
       VALUES (?, 50, 'support_adjustment', 'test-seed', 'test', ?)`,
      body.user!.id,
      Date.now(),
    ).run();
    const base = {
      usageKind: 'video' as const,
      modelId: 'test/vision',
      credits: 40,
    };
    expect(
      await reserveCredits(env, body.user!.id, {
        ...base,
        idempotencyKey: 'request:video:one',
      }),
    ).toMatchObject({ allowed: true, available: 10 });
    expect(
      await reserveCredits(env, body.user!.id, {
        ...base,
        idempotencyKey: 'request:video:two',
      }),
    ).toMatchObject({ allowed: false, available: 10 });
    expect(await releaseCredits(env, body.user!.id, 'request:video:one')).toMatchObject({
      status: 'released',
      available: 50,
    });

    const oversized = await reserveCredits(env, body.user!.id, {
      ...base,
      idempotencyKey: 'request:video:oversized-settlement',
    });
    expect(oversized).toMatchObject({ allowed: true, available: 10, reserved: 40 });
    expect(
      await settleCredits(env, body.user!.id, 'request:video:oversized-settlement', 41, {}),
    ).toMatchObject({ status: 'released', available: 50, reserved: 0, charged: null });
  });

  it('只允许管理员按固定人民币档位幂等入账', async () => {
    const admin = await registerUser();
    const buyer = await registerUser({ username: 'buyer', email: 'buyer@example.com' });
    await prepared("UPDATE users SET role = 'admin' WHERE id = ?", admin.body.user!.id).run();
    const input = { username: 'buyer', amountCny: 7, externalReference: 'alipay:test:001' };

    const granted = await post('/api/auth/admin/credits/grant', input, {
      token: admin.body.token,
    });
    expect(granted.status).toBe(201);
    expect(await granted.json()).toMatchObject({ amountCny: 7, amountCredits: 1000 });
    expect(
      (await post('/api/auth/admin/credits/grant', input, { token: admin.body.token })).status,
    ).toBe(409);
    expect(
      (await post('/api/auth/admin/credits/grant', input, { token: buyer.body.token })).status,
    ).toBe(403);
    expect(await creditBalance(env, buyer.body.user!.id)).toEqual({
      total: 1000,
      reserved: 0,
      available: 1000,
    });
  });

  it('允许管理员无交易流水赠送 Credit，并生成独立审计编号', async () => {
    const admin = await registerUser();
    const recipient = await registerUser({ username: 'gifted', email: 'gifted@example.com' });
    await prepared("UPDATE users SET role = 'admin' WHERE id = ?", admin.body.user!.id).run();

    const response = await post(
      '/api/auth/admin/credits/gift',
      { username: 'gifted', amountCredits: 888, reason: '社区活动奖励' },
      { token: admin.body.token },
    );
    expect(response.status).toBe(201);
    const result = (await response.json()) as { referenceId: string };
    expect(result.referenceId).toMatch(/^gift:/);
    expect(await creditBalance(env, recipient.body.user!.id)).toEqual({
      total: 888,
      reserved: 0,
      available: 888,
    });
    expect(
      await prepared(
        'SELECT action, amount_cny, amount_credits, reason FROM admin_credit_audit WHERE target_user_id = ?',
        recipient.body.user!.id,
      ).first(),
    ).toMatchObject({
      action: 'admin_gift',
      amount_cny: null,
      amount_credits: 888,
      reason: '社区活动奖励',
    });
  });

  it('管理员按用户名查询账户 Credit 与邮箱验证状态', async () => {
    const admin = await registerUser();
    const target = await registerUser({ username: 'lookup', email: 'lookup@example.com' });
    await prepared("UPDATE users SET role = 'admin' WHERE id = ?", admin.body.user!.id).run();
    await prepared(
      'UPDATE users SET email_verified_at = 1 WHERE id = ?',
      target.body.user!.id,
    ).run();
    const response = await worker.fetch(
      req('/api/auth/admin/credits/users/@Lookup', { token: admin.body.token }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      user: { id: target.body.user!.id, username: 'lookup', emailVerified: true },
      credit: { available: 0 },
    });
    expect(
      (
        await worker.fetch(
          req('/api/auth/admin/credits/users/lookup', { token: target.body.token }),
          env,
        )
      ).status,
    ).toBe(403);
  });

  it('拒绝非管理员赠送以及超出单笔上限的赠送', async () => {
    const user = await registerUser();
    expect(
      (
        await post(
          '/api/auth/admin/credits/gift',
          { username: 'alice', amountCredits: 100, reason: '测试' },
          { token: user.body.token },
        )
      ).status,
    ).toBe(403);
    await prepared("UPDATE users SET role = 'admin' WHERE id = ?", user.body.user!.id).run();
    expect(
      (
        await post(
          '/api/auth/admin/credits/gift',
          { username: 'alice', amountCredits: 20_001, reason: '测试' },
          { token: user.body.token },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await post(
          '/api/auth/admin/credits/gift',
          { username: 'alice', amountCredits: 1.5, reason: '测试' },
          { token: user.body.token },
        )
      ).status,
    ).toBe(400);
  });
});
