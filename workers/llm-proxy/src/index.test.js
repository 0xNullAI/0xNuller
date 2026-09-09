import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { chargedCredits, estimateReservation } from './index.js';

const model = {
  inputCreditsPerMillion: 600,
  cachedInputCreditsPerMillion: 150,
  outputCreditsPerMillion: 2400,
};

function environment(overrides = {}) {
  return {
    ALLOWED_ORIGINS: 'https://0xnullai.com',
    UPSTREAM_BASE_URL: 'https://upstream.example/v1',
    UPSTREAM_MODEL: 'vendor/model',
    INPUT_CREDITS_PER_MILLION: '600',
    CACHED_INPUT_CREDITS_PER_MILLION: '150',
    OUTPUT_CREDITS_PER_MILLION: '2400',
    PROXY_API_KEY: 'secret',
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
    expect(chargedCredits({ prompt_tokens: 10_000, completion_tokens: 2_000 }, model)).toBe(11);
  });

  it('按最大输出而不是平均回复冻结额度', () => {
    expect(
      estimateReservation(
        { messages: [{ role: 'user', content: 'hello' }], max_tokens: 1000 },
        model,
      ),
    ).toBeGreaterThanOrEqual(3);
  });
});

describe('平台模型请求', () => {
  it('先冻结、按真实用量结算并隐藏上游模型名', async () => {
    const env = environment();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          id: 'answer',
          model: 'vendor/model',
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 1000, completion_tokens: 100 },
        }),
      ),
    );
    const response = await worker.fetch(
      request({ model: 'forged', messages: [{ role: 'user', content: 'hello' }] }),
      env,
      { waitUntil: vi.fn() },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ model: 'balanced', credit_charged: 1 });
    expect(env.AUTH.reserveCredits).toHaveBeenCalledOnce();
    expect(env.AUTH.settleCredits).toHaveBeenCalledOnce();
    const upstreamBody = JSON.parse(vi.mocked(fetch).mock.calls[0][1].body);
    expect(upstreamBody.model).toBe('vendor/model');
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
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const response = await worker.fetch(
      request({ messages: [{ role: 'user', content: 'hello' }] }),
      env,
      { waitUntil: vi.fn() },
    );
    expect(response.status).toBe(402);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('上游失败时释放全部冻结额度', async () => {
    const env = environment();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({}, { status: 503 })));
    const response = await worker.fetch(
      request({ messages: [{ role: 'user', content: 'hello' }] }),
      env,
      { waitUntil: vi.fn() },
    );
    expect(response.status).toBe(502);
    expect(env.AUTH.releaseCredits).toHaveBeenCalledWith(expect.anything(), 'request:test:001');
  });
});
