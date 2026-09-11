import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { MODELS, chargedCredits, estimateReservation } from './index.js';

const model = MODELS.find((item) => item.id === 'balanced');
const powerfulModel = MODELS.find((item) => item.id === 'powerful');

function environment(overrides = {}) {
  return {
    ALLOWED_ORIGINS: 'https://0xnullai.com',
    AI: { run: vi.fn() },
    RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    AUTH: {
      creditBalance: vi.fn().mockResolvedValue({ total: 1000, reserved: 0, available: 1000 }),
      reserveCredits: vi.fn().mockResolvedValue({
        allowed: true,
        status: 'pending',
        total: 1000,
        reserved: 10,
        available: 990,
        charged: null,
      }),
      settleCredits: vi.fn().mockResolvedValue({ status: 'settled' }),
      releaseCredits: vi.fn().mockResolvedValue({ status: 'released' }),
    },
    ...overrides,
  };
}

function request(body, key = 'request:test:001') {
  return new Request('https://llm.0xnullai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Origin: 'https://0xnullai.com',
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    body: JSON.stringify(body),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('Credit 价格', () => {
  it('提供三个 Cloudflare 托管档位', () => {
    expect(MODELS.map((item) => item.id)).toEqual(['basic', 'balanced', 'powerful']);
    expect(MODELS.every((item) => item.upstreamId.startsWith('@cf/'))).toBe(true);
    expect(MODELS.every((item) => item.inputCreditsPerMillion > 0)).toBe(true);
  });

  it('分别计算缓存输入和输出并向上取整', () => {
    expect(
      chargedCredits(
        {
          prompt_tokens: 1000,
          prompt_tokens_details: { cached_tokens: 600 },
          completion_tokens: 200,
        },
        model,
      ),
    ).toBe(1);
    expect(chargedCredits({ prompt_tokens: 10_000, completion_tokens: 2_000 }, model)).toBe(3);
  });

  it('按最大输出而不是平均回复冻结额度', () => {
    expect(
      estimateReservation(
        { messages: [{ role: 'user', content: 'hello' }], max_tokens: 4096 },
        powerfulModel,
      ),
    ).toBeGreaterThanOrEqual(4);
  });
});

describe('平台模型请求', () => {
  it('先冻结、按真实用量结算并隐藏上游模型名', async () => {
    const env = environment({
      AI: {
        run: vi.fn().mockResolvedValue({
          id: 'answer',
          model: '@cf/zai-org/glm-4.7-flash',
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 1000, completion_tokens: 100 },
        }),
      },
    });
    const response = await worker.fetch(
      request({ model: 'balanced', messages: [{ role: 'user', content: 'hello' }] }),
      env,
      { waitUntil: vi.fn() },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ model: 'balanced', credit_charged: 1 });
    expect(env.AUTH.reserveCredits).toHaveBeenCalledOnce();
    expect(env.AUTH.settleCredits).toHaveBeenCalledOnce();
    expect(env.AI.run).toHaveBeenCalledWith(
      '@cf/zai-org/glm-4.7-flash',
      expect.not.objectContaining({ model: expect.anything() }),
    );
  });

  it('拒绝客户端伪造的模型 id', async () => {
    const env = environment();
    const response = await worker.fetch(
      request({ model: '@cf/private/model', messages: [{ role: 'user', content: 'hello' }] }),
      env,
      { waitUntil: vi.fn() },
    );
    expect(response.status).toBe(400);
    expect(env.AUTH.reserveCredits).not.toHaveBeenCalled();
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it('平台文字模型拒绝图片输入', async () => {
    const env = environment();
    const response = await worker.fetch(
      request({
        model: 'basic',
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }],
      }),
      env,
      { waitUntil: vi.fn() },
    );
    expect(response.status).toBe(400);
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it('余额不足时不调用上游', async () => {
    const env = environment({
      AUTH: {
        ...environment().AUTH,
        reserveCredits: vi.fn().mockResolvedValue({
          allowed: false,
          status: 'insufficient',
          total: 0,
          reserved: 0,
          available: 0,
        }),
      },
    });
    const response = await worker.fetch(
      request({ messages: [{ role: 'user', content: 'hello' }] }),
      env,
      { waitUntil: vi.fn() },
    );
    expect(response.status).toBe(402);
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it('上游失败时释放全部冻结额度', async () => {
    const env = environment({
      AI: { run: vi.fn().mockRejectedValue(new Error('model unavailable')) },
    });
    const response = await worker.fetch(
      request({ messages: [{ role: 'user', content: 'hello' }] }),
      env,
      { waitUntil: vi.fn() },
    );
    expect(response.status).toBe(503);
    expect(env.AUTH.releaseCredits).toHaveBeenCalledWith(expect.anything(), 'request:test:001');
  });
});
