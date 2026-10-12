import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parsePriceTable, tokenCredits, tokenReservation } from '@0xnullai/ai-pricing';
import exampleTable from '../../../packages/platform/ai-pricing/src/example-price-table.json';
import { ARK_CHAT_URL, MAX_OUTPUT_TOKENS } from './ark.js';
import worker, * as workerModule from './index.js';
import { CONTENT_FILTER_REPLY } from './content-filter.js';
import { VISION_MAX_INPUT_TOKENS, estimateInputTokens } from './routing.js';

const table = parsePriceTable(exampleTable);
const usage = { prompt_tokens: 1000, completion_tokens: 100 };

function environment(overrides = {}) {
  const env = {
    ALLOWED_ORIGINS: 'https://0xnullai.com',
    AI_PRICE_TABLE: JSON.stringify(exampleTable),
    VOLC_ARK_API_KEY: 'test-ark-key',
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
      settleCredits: vi.fn((_auth, _key, charge) =>
        Promise.resolve({ status: 'settled', charged: charge }),
      ),
      releaseCredits: vi.fn().mockResolvedValue({ status: 'released' }),
    },
    ...overrides,
  };
  env.AUTH.reserveManagedTextCredits = vi.fn(async (...args) => {
    const result = await env.AUTH.reserveCredits(...args);
    return result && typeof result === 'object'
      ? { ...result, capability: 'test-capability' }
      : result;
  });
  env.AUTH.authorizeManagedGroupText = vi.fn().mockResolvedValue({ payer: 'alice' });
  env.AUTH.inspectManagedText = vi
    .fn()
    .mockResolvedValue({ recovery: 'running', status: 'pending' });
  env.AUTH.heartbeatManagedText = vi.fn().mockResolvedValue({ status: 'running' });
  let checkpoint;
  env.AUTH.checkpointManagedText = vi.fn(async (_key, _capability, charge, metadata) => {
    checkpoint = { charge, metadata };
    return { status: 'checkpointed' };
  });
  env.AUTH.finalizeManagedText = vi.fn((_key, _capability, action) =>
    action === 'settle'
      ? env.AUTH.settleCredits({}, _key, checkpoint.charge, checkpoint.metadata)
      : env.AUTH.releaseCredits({}, _key),
  );
  return env;
}

/**
 * Stub Ark. Each entry answers one upstream call: a Response factory, an Error to reject with,
 * or 'hang' to wait until the call is aborted.
 */
function stubArk(...answers) {
  const calls = [];
  const fetch = vi.fn(async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    if (answer === 'hang')
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? answer(init) : answer;
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, calls };
}

function completion(content, reportedUsage = usage, finishReason = 'stop', extra = {}) {
  return () =>
    Response.json({
      id: 'answer',
      object: 'chat.completion',
      model: 'example-chat-model',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content, ...extra },
          finish_reason: finishReason,
        },
      ],
      ...(reportedUsage === null ? {} : { usage: reportedUsage }),
    });
}

function rawCompletion(payload) {
  return () => Response.json(payload);
}

function arkError(status, code = 'InternalServiceError') {
  return () => Response.json({ error: { code, message: 'x', type: 'x' } }, { status });
}

function sseStream(chunks, cancel = vi.fn()) {
  const source = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
    },
    cancel,
  });
  return { response: () => new Response(source), cancel };
}

function frame(event) {
  return 'data: ' + JSON.stringify(event) + '\n\n';
}

function delta(content, finishReason = null) {
  return frame({
    object: 'chat.completion.chunk',
    model: 'example-chat-model',
    choices: [{ index: 0, delta: { content }, finish_reason: finishReason }],
  });
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

function groupRequest(body, key = 'group-ai:test:001') {
  const input = request(body, key);
  input.headers.set('X-0xNullAI-Group-Ticket', 'server-signed-ticket');
  return input;
}

function modelsRequest() {
  return new Request('https://llm.0xnullai.com/v1/models', {
    headers: { Origin: 'https://0xnullai.com' },
  });
}

function context() {
  const tasks = [];
  return { tasks, waitUntil: (promise) => tasks.push(promise) };
}

const streamingBody = {
  stream: true,
  model: 'balanced',
  messages: [{ role: 'user', content: 'hello' }],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('managed configuration', () => {
  it.each([
    ['missing price table', { AI_PRICE_TABLE: undefined }],
    ['invalid price table', { AI_PRICE_TABLE: '{"version":"x"}' }],
    ['missing Ark key', { VOLC_ARK_API_KEY: undefined }],
    ['blank Ark key', { VOLC_ARK_API_KEY: '  ' }],
  ])('fails closed with 503 and no hold on a %s', async (_name, overrides) => {
    const { fetch } = stubArk(completion('never'));
    const env = environment(overrides);
    const response = await worker.fetch(
      request({ messages: [{ role: 'user', content: 'hi' }] }),
      env,
      context(),
    );
    expect(response.status).toBe(503);
    expect((await worker.fetch(modelsRequest(), env, context())).status).toBe(503);
    expect(env.AUTH.reserveManagedTextCredits).not.toHaveBeenCalled();
    expect(env.RATE_LIMITER.limit).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('lists one text model and the camera quote from the table without upstream ids', async () => {
    const env = environment();
    const response = await worker.fetch(modelsRequest(), env, context());
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data.map((item) => item.id)).toEqual(['balanced', 'vision']);
    expect(data[0]).toMatchObject({
      inputCreditsPerMillion: table.chat.inputPerMillion,
      cachedInputCreditsPerMillion: table.chat.cachedInputPerMillion,
      outputCreditsPerMillion: table.chat.outputPerMillion,
      priceVersion: table.version,
      imageInput: false,
    });
    expect(data[1]).toMatchObject({
      imageInput: true,
      priceVersion: table.version,
      maxReservationCredits: tokenReservation(
        table.vision,
        VISION_MAX_INPUT_TOKENS,
        MAX_OUTPUT_TOKENS,
      ),
    });
    for (const route of [table.chat, table.vision])
      expect(JSON.stringify(data)).not.toContain(route.model);
  });
});

describe('Ark upstream request', () => {
  it.each(['basic', 'balanced', 'powerful', undefined])(
    'routes former text id %s to the single chat route at the table price',
    async (model) => {
      const { calls } = stubArk(completion('ok'));
      const env = environment();
      const body = { model, messages: [{ role: 'user', content: 'hello' }], max_tokens: 300 };
      const response = await worker.fetch(request(body), env, context());
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        model: model ?? 'balanced',
        credit_charged: tokenCredits(table.chat, usage),
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(ARK_CHAT_URL);
      expect(calls[0].body.model).toBe(table.chat.model);
      expect(env.AUTH.reserveCredits.mock.calls[0][1]).toMatchObject({
        modelId: model ?? 'balanced',
        credits: tokenReservation(table.chat, estimateInputTokens(body), 300),
      });
    },
  );

  it('always disables thinking, caps output, drops client-only fields and authenticates', async () => {
    const { calls } = stubArk(completion('ok'));
    const env = environment();
    await worker.fetch(
      request({
        model: 'balanced',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 99_999,
        thinking: { type: 'enabled' },
        api_key: 'sk-user',
        max_completion_tokens: 5,
        tools: [{ type: 'function', function: { name: 'device_stop' } }],
        tool_choice: 'auto',
        temperature: 0.7,
      }),
      env,
      context(),
    );
    const sent = calls[0];
    expect(sent.init.headers.Authorization).toBe('Bearer test-ark-key');
    expect(sent.body.thinking).toEqual({ type: 'disabled' });
    expect(sent.body.max_tokens).toBe(MAX_OUTPUT_TOKENS);
    expect(sent.body).not.toHaveProperty('api_key');
    expect(sent.body).not.toHaveProperty('max_completion_tokens');
    expect(sent.body).toMatchObject({ tool_choice: 'auto', temperature: 0.7, stream: false });
    expect(sent.body.tools).toHaveLength(1);
    expect(env.AUTH.reserveCredits.mock.calls[0][1].credits).toBe(
      tokenReservation(
        table.chat,
        estimateInputTokens({
          messages: [{ role: 'user', content: 'hello' }],
          tools: [{ type: 'function', function: { name: 'device_stop' } }],
          tool_choice: 'auto',
        }),
        MAX_OUTPUT_TOKENS,
      ),
    );
  });

  it('keys the prompt cache by a stable digest of the owned conversation, never the raw id', async () => {
    const { calls } = stubArk(completion('ok'));
    const env = environment();
    const send = async (conversation, key) => {
      const input = request({ messages: [{ role: 'user', content: 'hello' }] }, key);
      if (conversation) {
        input.headers.set('X-0xNullAI-Conversation-Id', conversation);
        input.headers.set('X-0xNullAI-Run-Id', 'run:actual:001');
      }
      expect((await worker.fetch(input, env, context())).status).toBe(200);
    };
    await send('private-chat', 'request:test:001');
    await send('private-chat', 'request:test:002');
    await send('other-chat', 'request:test:003');
    await send(null, 'request:test:004');
    const keys = calls.map((call) => call.body.prompt_cache_key);
    expect(keys[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys[3]).toBeUndefined();
    expect(JSON.stringify(calls.map((call) => call.body))).not.toContain('private-chat');
  });

  it('bills cached input at the cached price from real usage', async () => {
    const cached = {
      prompt_tokens: 200_000,
      completion_tokens: 1000,
      prompt_tokens_details: { cached_tokens: 150_000 },
    };
    stubArk(completion('ok', cached));
    const env = environment();
    const response = await worker.fetch(
      request({ messages: [{ role: 'user', content: 'x'.repeat(300_000) }] }),
      env,
      context(),
    );
    const charge = tokenCredits(table.chat, cached);
    expect(charge).toBeLessThan(
      tokenCredits(table.chat, { prompt_tokens: 200_000, completion_tokens: 1000 }),
    );
    expect(await response.json()).toMatchObject({ credit_charged: charge });
    expect(env.AUTH.settleCredits).toHaveBeenCalledWith(
      expect.anything(),
      'request:test:001',
      charge,
      expect.objectContaining({ usage: cached, priceVersion: table.version }),
    );
  });
});

describe('fallback model', () => {
  it.each([
    ['rate limit', arkError(429, 'AccountRateLimitExceeded')],
    ['server error', arkError(500)],
    ['network failure', new Error('connection reset')],
  ])('retries once on the fallback after a primary %s, at the same price', async (_n, failure) => {
    const { calls } = stubArk(failure, completion('ok'));
    const env = environment();
    const response = await worker.fetch(request({ messages: [] }), env, context());
    expect(response.status).toBe(200);
    expect(calls.map((call) => call.body.model)).toEqual([
      table.chat.model,
      table.chat.fallbackModel,
    ]);
    expect(env.AUTH.settleCredits).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      tokenCredits(table.chat, usage),
      expect.objectContaining({ model: 'balanced', upstreamModel: table.chat.fallbackModel }),
    );
  });

  it('retries a primary that times out before its result', async () => {
    vi.useFakeTimers();
    const { calls } = stubArk('hang', completion('ok'));
    const env = environment();
    const pending = worker.fetch(request({ messages: [] }), env, context());
    await vi.advanceTimersByTimeAsync(121_000);
    expect((await pending).status).toBe(200);
    expect(calls.map((call) => call.body.model)).toEqual([
      table.chat.model,
      table.chat.fallbackModel,
    ]);
  });

  it('retries a stream that is silent before its first byte', async () => {
    vi.useFakeTimers();
    const silent = () => new Response(new ReadableStream());
    const { response } = sseStream([
      delta('hi'),
      frame({ choices: [], usage }),
      'data: [DONE]\n\n',
    ]);
    const { calls } = stubArk(silent, response);
    const env = environment();
    const ctx = context();
    const pending = worker.fetch(request(streamingBody), env, ctx);
    await vi.advanceTimersByTimeAsync(31_000);
    const result = await pending;
    expect(await result.text()).toContain('[DONE]');
    await Promise.all(ctx.tasks);
    expect(calls.map((call) => call.body.model)).toEqual([
      table.chat.model,
      table.chat.fallbackModel,
    ]);
  });

  it('never retries once the stream has produced output', async () => {
    let read = 0;
    const source = new ReadableStream({
      pull(c) {
        if (read++ === 0) c.enqueue(new TextEncoder().encode(delta('partial')));
        else c.error(new Error('upstream interrupted'));
      },
    });
    const { calls } = stubArk(() => new Response(source), completion('never'));
    const env = environment();
    const ctx = context();
    const response = await worker.fetch(request(streamingBody), env, ctx);
    await expect(response.text()).rejects.toThrow();
    await Promise.all(ctx.tasks);
    expect(calls).toHaveLength(1);
    expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
  });

  it('does not retry a client error and releases the untouched hold', async () => {
    const { calls } = stubArk(arkError(400, 'InvalidParameter'));
    const env = environment();
    const response = await worker.fetch(request({ messages: [] }), env, context());
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ billing_status: 'released' });
    expect(calls).toHaveLength(1);
    expect(env.AUTH.releaseCredits).toHaveBeenCalledOnce();
  });

  it('keeps the hold pending when both primary and fallback time out', async () => {
    vi.useFakeTimers();
    stubArk('hang');
    const env = environment();
    const pending = worker.fetch(request({ messages: [] }), env, context());
    await vi.advanceTimersByTimeAsync(241_000);
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ billing_status: 'pending' });
    expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
  });
});

describe('finish reasons', () => {
  it('delivers a reply cut at the output cap and records the truncation', async () => {
    stubArk(completion('部分回复', usage, 'length'));
    const env = environment();
    const response = await worker.fetch(request({ messages: [] }), env, context());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      truncated: true,
      choices: [{ message: { content: '部分回复' } }],
    });
    expect(env.AUTH.settleCredits.mock.calls[0][3]).toMatchObject({
      finishReason: 'length',
      truncated: true,
    });
  });

  it('bills but never reports an empty cut-off reply as success', async () => {
    stubArk(completion('', usage, 'length'));
    const env = environment();
    const response = await worker.fetch(request({ messages: [] }), env, context());
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      billing_status: 'settled',
      credit_charged: tokenCredits(table.chat, usage),
    });
  });

  it('streams a truncated reply to the end and records it', async () => {
    const { response } = sseStream([
      delta('部分', 'length'),
      frame({ choices: [], usage }),
      'data: [DONE]\n\n',
    ]);
    stubArk(response);
    const env = environment();
    const ctx = context();
    const text = await (await worker.fetch(request(streamingBody), env, ctx)).text();
    await Promise.all(ctx.tasks);
    expect(text).toContain('部分');
    expect(text).toContain('[DONE]');
    expect(env.AUTH.settleCredits.mock.calls[0][3]).toMatchObject({ truncated: true });
  });

  it('replaces a moderated completion with a neutral reply and bills real usage', async () => {
    stubArk(
      completion('', usage, 'content_filter', {
        tool_calls: [{ id: 'c', type: 'function', function: { name: 'x', arguments: '{}' } }],
      }),
    );
    const env = environment();
    const response = await worker.fetch(request({ messages: [] }), env, context());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      content_filtered: true,
      credit_charged: tokenCredits(table.chat, usage),
      choices: [{ message: { content: CONTENT_FILTER_REPLY }, finish_reason: 'stop' }],
    });
    expect(body.choices[0].message.tool_calls).toBeUndefined();
    expect(env.AUTH.settleCredits.mock.calls[0][3]).toMatchObject({ contentFiltered: true });
  });

  it('ends a moderated stream with the neutral reply', async () => {
    const { response } = sseStream([
      delta('开头'),
      delta('', 'content_filter'),
      frame({ choices: [], usage }),
      'data: [DONE]\n\n',
    ]);
    stubArk(response);
    const env = environment();
    const ctx = context();
    const text = await (await worker.fetch(request(streamingBody), env, ctx)).text();
    await Promise.all(ctx.tasks);
    expect(text).toContain(CONTENT_FILTER_REPLY);
    expect(text).not.toContain('content_filter');
    expect(env.AUTH.settleCredits.mock.calls[0][3]).toMatchObject({ contentFiltered: true });
  });

  it('answers neutrally and charges nothing when Ark refuses the input itself', async () => {
    stubArk(arkError(400, 'InputTextSensitiveContentDetected'));
    const env = environment();
    const response = await worker.fetch(request({ messages: [] }), env, context());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      credit_charged: 0,
      content_filtered: true,
      choices: [{ message: { content: CONTENT_FILTER_REPLY } }],
    });
    expect(env.AUTH.releaseCredits).toHaveBeenCalledOnce();
    expect(env.AUTH.settleCredits).not.toHaveBeenCalled();
    stubArk(arkError(400, 'InputTextSensitiveContentDetected'));
    const streamed = await worker.fetch(request(streamingBody, 'request:test:002'), env, context());
    expect(await streamed.text()).toContain(CONTENT_FILTER_REPLY);
  });
});

describe('streaming settlement', () => {
  it('relays deltas, hides the upstream model and settles the usage chunk', async () => {
    const { response } = sseStream([
      delta('你好'),
      frame({ choices: [], usage }),
      'data: [DONE]\n\n',
    ]);
    const { calls } = stubArk(response);
    const env = environment();
    const ctx = context();
    const text = await (await worker.fetch(request(streamingBody), env, ctx)).text();
    await Promise.all(ctx.tasks);
    expect(calls[0].body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: 'disabled' },
    });
    expect(text).toContain('你好');
    expect(text).not.toContain('example-chat-model');
    expect(env.AUTH.settleCredits).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      'request:test:001',
      tokenCredits(table.chat, usage),
      expect.objectContaining({ usage, upstreamModel: table.chat.model }),
    );
  });

  it('keeps a stream without usage pending for review and fails the response', async () => {
    const { response } = sseStream([delta('你好'), 'data: [DONE]\n\n']);
    stubArk(response);
    const env = environment();
    const ctx = context();
    const result = await worker.fetch(request(streamingBody), env, ctx);
    await expect(result.text()).rejects.toThrow('valid usage');
    await Promise.all(ctx.tasks);
    expect(env.AUTH.settleCredits).not.toHaveBeenCalled();
    expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
    expect(env.AUTH.finalizeManagedText).not.toHaveBeenCalled();
  });
});

describe('平台模型请求', () => {
  it('uses a signed group reservation and payer context, never browser credentials', async () => {
    const { calls } = stubArk(completion('群聊回复', { prompt_tokens: 20, completion_tokens: 10 }));
    const env = environment();
    env.AUTH.reserveManagedGroupTextCredits = vi.fn().mockResolvedValue({
      allowed: true,
      status: 'pending',
      capability: 'group-capability',
      groupContext: { room: 'group', triggerId: 'm1', roleId: 'room', payer: 'alice' },
    });
    const response = await worker.fetch(
      groupRequest({
        model: 'balanced',
        stream: false,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      env,
      context(),
    );
    expect(response.status).toBe(200);
    expect(env.AUTH.reserveManagedTextCredits).not.toHaveBeenCalled();
    expect(env.AUTH.reserveManagedGroupTextCredits).toHaveBeenCalledWith(
      'server-signed-ticket',
      expect.objectContaining({
        idempotencyKey: 'group-ai:test:001',
        modelId: 'balanced',
        bodyHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
    expect(env.RATE_LIMITER.limit).toHaveBeenCalledWith({ key: 'group-payer:alice' });
    expect(env.AUTH.settleCredits).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      1,
      expect.objectContaining({
        groupContext: expect.objectContaining({ payer: 'alice', triggerId: 'm1' }),
      }),
    );
    expect(calls[0].body.prompt_cache_key).toMatch(/^[a-f0-9]{64}$/);
    expect(calls[0].body.prompt_cache_key).not.toContain('group');
  });

  it('does not invoke the model when the triggering member lacks Credit', async () => {
    const { fetch } = stubArk(completion('never'));
    const env = environment();
    env.AUTH.reserveManagedGroupTextCredits = vi
      .fn()
      .mockResolvedValue({ allowed: false, status: 'insufficient' });
    const response = await worker.fetch(groupRequest({ messages: [] }), env, context());
    expect(response.status).toBe(402);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an invalid group ticket before limiter, reservation or model call', async () => {
    const { fetch } = stubArk(completion('never'));
    const env = environment();
    env.AUTH.authorizeManagedGroupText.mockResolvedValue('unauthorized');
    const response = await worker.fetch(groupRequest({ messages: [] }), env, context());
    expect(response.status).toBe(401);
    expect(env.RATE_LIMITER.limit).not.toHaveBeenCalled();
    expect(env.AUTH.reserveManagedGroupTextCredits).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects group streaming and tools before any reservation', async () => {
    const env = environment();
    const response = await worker.fetch(groupRequest({ messages: [], tools: [] }), env, context());
    expect(response.status).toBe(400);
    expect(env.AUTH.reserveManagedTextCredits).not.toHaveBeenCalled();
  });

  it('拒绝客户端伪造的模型 id', async () => {
    const { fetch } = stubArk(completion('never'));
    const env = environment();
    const response = await worker.fetch(
      request({ model: 'example-chat-model', messages: [{ role: 'user', content: 'hello' }] }),
      env,
      context(),
    );
    expect(response.status).toBe(400);
    expect(env.AUTH.reserveCredits).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('平台文字模型拒绝图片输入', async () => {
    const { fetch } = stubArk(completion('never'));
    const env = environment();
    const response = await worker.fetch(
      request({
        model: 'basic',
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }],
      }),
      env,
      context(),
    );
    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('余额不足时不调用上游', async () => {
    const { fetch } = stubArk(completion('never'));
    const env = environment();
    env.AUTH.reserveCredits.mockResolvedValue({
      allowed: false,
      status: 'insufficient',
      total: 0,
      reserved: 0,
      available: 0,
    });
    const response = await worker.fetch(
      request({ messages: [{ role: 'user', content: 'hello' }] }),
      env,
      context(),
    );
    expect(response.status).toBe(402);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('managed response billing boundaries', () => {
  it('counts tool schemas when reserving maximum possible input', () => {
    const base = { messages: [] };
    expect(
      estimateInputTokens({ ...base, tools: [{ function: { description: 'x'.repeat(100000) } }] }),
    ).toBeGreaterThan(estimateInputTokens(base) + 100000);
  });
  it('retries an ambiguous settlement with the same key and never switches to release', async () => {
    stubArk(rawCompletion({ usage, choices: [] }));
    const env = environment();
    env.AUTH.settleCredits
      .mockRejectedValueOnce(new Error('reply lost after commit'))
      .mockResolvedValue({ status: 'settled', charged: 1 });
    const result = await worker.fetch(request({ messages: [] }), env, context());
    expect(result.status).toBe(200);
    expect(env.AUTH.settleCredits).toHaveBeenCalledTimes(2);
    expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
  });
  it('does not claim payment success or release after permanently ambiguous settlement', async () => {
    stubArk(rawCompletion({ usage, choices: [] }));
    const env = environment();
    env.AUTH.settleCredits.mockRejectedValue(new Error('unreachable'));
    const result = await worker.fetch(request({ messages: [] }), env, context());
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({ billing_status: 'pending' });
    expect(env.AUTH.settleCredits).toHaveBeenCalledTimes(3);
    expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
  });
  it('checks actual terminal states and rejects invalid usage rather than charging minimum by accident', async () => {
    stubArk(rawCompletion({ usage, choices: [] }));
    const env = environment();
    env.AUTH.settleCredits.mockResolvedValue({ status: 'released', charged: null });
    const result = await worker.fetch(request({ messages: [] }), env, context());
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({ billing_status: 'released' });
    expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
    stubArk(rawCompletion({ usage: { prompt_tokens: -1, completion_tokens: 'junk' } }));
    const invalid = await worker.fetch(request({ messages: [] }), env, context());
    expect(invalid.status).toBe(502);
    expect(await invalid.json()).toMatchObject({ billing_status: 'pending' });
    expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
    expect(env.AUTH.settleCredits).toHaveBeenCalledOnce();
  });
  it('keeps a completed but unmetered response for review instead of releasing its hold', async () => {
    stubArk(rawCompletion({ choices: [] }));
    const env = environment();
    const result = await worker.fetch(request({ messages: [] }), env, context());
    expect(result.status).toBe(502);
    expect(await result.json()).toMatchObject({ billing_status: 'pending' });
    expect(env.AUTH.finalizeManagedText).not.toHaveBeenCalled();
    expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
  });
  it('keeps usage above the hold for review instead of settling it', async () => {
    stubArk(completion('ok', { prompt_tokens: 50_000_000, completion_tokens: 1 }));
    const env = environment();
    const result = await worker.fetch(request({ messages: [] }), env, context());
    expect(result.status).toBe(502);
    expect(await result.json()).toMatchObject({ billing_status: 'pending' });
    expect(env.AUTH.finalizeManagedText).not.toHaveBeenCalled();
  });
  it('releases only an explicit rejected upstream response with no result', async () => {
    stubArk(arkError(403, 'OperationDenied.ServiceNotOpen'));
    const env = environment();
    const result = await worker.fetch(request({ messages: [] }), env, context());
    expect(result.status).toBe(502);
    expect(await result.json()).toMatchObject({ billing_status: 'released' });
    expect(env.AUTH.releaseCredits).toHaveBeenCalledOnce();
    expect(env.AUTH.settleCredits).not.toHaveBeenCalled();
  });
  it('parses split CRLF and final usage without a newline, then settles', async () => {
    const bytes = ['data: {"choices":[]}\r', '\n\r\n', 'data: ' + JSON.stringify({ usage })];
    const source = new ReadableStream({
      start(c) {
        bytes.forEach((b) => c.enqueue(new TextEncoder().encode(b)));
        c.close();
      },
    });
    stubArk(() => new Response(source));
    const env = environment();
    const ctx = context();
    const result = await worker.fetch(request(streamingBody), env, ctx);
    expect(await result.text()).toContain('prompt_tokens');
    await Promise.all(ctx.tasks);
    expect(env.AUTH.settleCredits).toHaveBeenCalledOnce();
    expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
  });
  it('withholds DONE until settlement is acknowledged', async () => {
    const { response } = sseStream([frame({ usage }) + 'data: [DONE]\n\n']);
    stubArk(response);
    let resolve;
    const settled = new Promise((r) => {
      resolve = r;
    });
    const env = environment();
    env.AUTH.settleCredits.mockReturnValue(settled);
    const ctx = context();
    const result = await worker.fetch(request(streamingBody), env, ctx);
    const reader = result.body.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).not.toContain('[DONE]');
    let terminalDelivered = false;
    const next = reader.read().then((v) => {
      terminalDelivered = true;
      return v;
    });
    await Promise.resolve();
    expect(terminalDelivered).toBe(false);
    resolve({ status: 'settled', charged: 1 });
    expect(new TextDecoder().decode((await next).value)).toContain('[DONE]');
    await reader.read();
    await Promise.all(ctx.tasks);
  });
  it('records usage already received in the same chunk before downstream cancellation', async () => {
    const cancel = vi.fn();
    const source = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n' + frame({ usage })));
      },
      cancel,
    });
    stubArk(() => new Response(source));
    const env = environment();
    const ctx = context();
    const result = await worker.fetch(request(streamingBody), env, ctx);
    const reader = result.body.getReader();
    await reader.read();
    await reader.cancel();
    await Promise.all(ctx.tasks);
    expect(cancel).toHaveBeenCalled();
    expect(env.AUTH.settleCredits).toHaveBeenCalledOnce();
    expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
  });
  it('cancels a blocked upstream reader and retains an unmetered hold for review', async () => {
    const { response, cancel } = sseStream(['data: {"choices":[]}\n\n']);
    stubArk(response);
    const env = environment();
    const ctx = context();
    const result = await worker.fetch(request(streamingBody), env, ctx);
    const reader = result.body.getReader();
    await reader.read();
    await reader.cancel();
    await Promise.all(ctx.tasks);
    expect(cancel).toHaveBeenCalled();
    expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
    expect(env.AUTH.finalizeManagedText).not.toHaveBeenCalled();
    expect(env.AUTH.settleCredits).not.toHaveBeenCalled();
  });
  it('does not emit DONE on a failed settlement and never releases that ambiguous charge', async () => {
    const { response } = sseStream([frame({ usage }) + 'data: [DONE]\n\n']);
    stubArk(response);
    const env = environment();
    env.AUTH.settleCredits.mockRejectedValue(new Error('offline'));
    const ctx = context();
    const result = await worker.fetch(request(streamingBody), env, ctx);
    await expect(result.text()).rejects.toThrow();
    await Promise.all(ctx.tasks);
    expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
  });
});

describe('managed cancellation and RPC deadline', () => {
  it('does not rerun an idempotency key whose reservation is already pending', async () => {
    const { fetch } = stubArk(completion('never'));
    const env = environment();
    env.AUTH.reserveCredits.mockResolvedValue({ allowed: false, status: 'pending' });
    const response = await worker.fetch(request({ messages: [] }), env, context());
    expect(response.status).toBe(409);
    expect(fetch).not.toHaveBeenCalled();
    expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
  });
  it('bounds settlement RPC deadlines and retains the original settle action', async () => {
    vi.useFakeTimers();
    stubArk(rawCompletion({ usage }));
    const env = environment();
    env.AUTH.settleCredits.mockImplementation(() => new Promise(() => {}));
    const pending = worker.fetch(request({ messages: [] }), env, context());
    await vi.advanceTimersByTimeAsync(9100);
    const response = await pending;
    expect(response.status).toBe(503);
    expect(env.AUTH.settleCredits).toHaveBeenCalledTimes(3);
    expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
  });
  it('aborts a blocked upstream when the request signal is cancelled', async () => {
    const controller = new AbortController();
    const { response, cancel } = sseStream([delta('')]);
    stubArk(response);
    const env = environment();
    const ctx = context();
    const original = request(streamingBody);
    const result = await worker.fetch(
      new Request(original, { signal: controller.signal }),
      env,
      ctx,
    );
    controller.abort();
    await expect(result.text()).rejects.toThrow();
    await Promise.all(ctx.tasks);
    expect(cancel).toHaveBeenCalled();
    expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
    expect(env.AUTH.finalizeManagedText).not.toHaveBeenCalled();
  });
});

it('settles confirmed usage even when upstream fails after its usage frame', async () => {
  let read = 0;
  const source = new ReadableStream({
    pull(c) {
      if (read++ === 0) c.enqueue(new TextEncoder().encode(frame({ usage })));
      else c.error(new Error('upstream interrupted'));
    },
  });
  stubArk(() => new Response(source));
  const env = environment();
  const ctx = context();
  const response = await worker.fetch(request(streamingBody), env, ctx);
  await expect(response.text()).rejects.toThrow();
  await Promise.all(ctx.tasks);
  expect(env.AUTH.settleCredits).toHaveBeenCalledOnce();
  expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
});

it('finalizes at DONE without waiting for EOF and ignores usage after termination', async () => {
  const { response, cancel } = sseStream([
    frame({ usage }) +
      'data: [DONE]\n\n' +
      frame({ usage: { prompt_tokens: 100000, completion_tokens: 100000 } }),
  ]);
  stubArk(response);
  const env = environment();
  const ctx = context();
  const text = await (await worker.fetch(request(streamingBody), env, ctx)).text();
  await Promise.all(ctx.tasks);
  expect(text).toContain('[DONE]');
  expect(text).not.toContain('100000');
  expect(cancel).toHaveBeenCalledOnce();
  expect(env.AUTH.settleCredits).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    'request:test:001',
    1,
    expect.objectContaining({ usage }),
  );
});

it('does not treat usage after DONE as evidence for a charge', async () => {
  const { response } = sseStream(['data: [DONE]\n\n' + frame({ usage })]);
  stubArk(response);
  const env = environment();
  const ctx = context();
  const result = await worker.fetch(request(streamingBody), env, ctx);
  await expect(result.text()).rejects.toThrow('valid usage');
  await Promise.all(ctx.tasks);
  expect(env.AUTH.settleCredits).not.toHaveBeenCalled();
  expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
  expect(env.AUTH.finalizeManagedText).not.toHaveBeenCalled();
});

it.each([null, { allowed: true, status: 'settled' }, { allowed: 'yes', status: 'pending' }])(
  'fails closed on an invalid reserve acknowledgement %j',
  async (acknowledgement) => {
    const { fetch } = stubArk(completion('never'));
    const env = environment();
    env.AUTH.reserveCredits.mockResolvedValue(acknowledgement);
    const response = await worker.fetch(request({ messages: [] }), env, context());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ billing_status: 'unknown' });
    expect(fetch).not.toHaveBeenCalled();
    expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
  },
);

it('bounds ambiguous reserve and leaves a repeated pending key untouched', async () => {
  vi.useFakeTimers();
  const { fetch } = stubArk(completion('never'));
  const env = environment();
  env.AUTH.reserveCredits.mockImplementationOnce(() => new Promise(() => {}));
  const pending = worker.fetch(request({ messages: [] }), env, context());
  await vi.advanceTimersByTimeAsync(3100);
  expect((await pending).status).toBe(503);
  env.AUTH.reserveCredits.mockResolvedValue({ allowed: false, status: 'pending' });
  const repeated = await worker.fetch(request({ messages: [] }), env, context());
  expect(repeated.status).toBe(409);
  expect(fetch).not.toHaveBeenCalled();
  expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
  expect(env.AUTH.settleCredits).not.toHaveBeenCalled();
});

it('fails closed when durable usage cannot be acknowledged, without changing to release', async () => {
  stubArk(rawCompletion({ usage, choices: [] }));
  const env = environment();
  env.AUTH.checkpointManagedText.mockRejectedValue(new Error('D1 unavailable'));
  const response = await worker.fetch(request({ messages: [] }), env, context());
  expect(response.status).toBe(503);
  expect(env.AUTH.checkpointManagedText).toHaveBeenCalledTimes(3);
  expect(env.AUTH.finalizeManagedText).not.toHaveBeenCalled();
  expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
});

it('settles by reservation capability even when the original browser credentials have expired', async () => {
  stubArk(rawCompletion({ usage, choices: [] }));
  const env = environment();
  env.AUTH.finalizeManagedText.mockResolvedValue({ status: 'settled', charged: 1 });
  const response = await worker.fetch(request({ messages: [] }), env, context());
  expect(response.status).toBe(200);
  expect(env.AUTH.finalizeManagedText).toHaveBeenCalledWith(
    'request:test:001',
    'test-capability',
    'settle',
  );
  expect(env.AUTH.settleCredits).not.toHaveBeenCalled();
});

it('does not deliver a usage frame or DONE before its durable checkpoint is acknowledged', async () => {
  const { response } = sseStream([frame({ usage }) + 'data: [DONE]\n\n']);
  stubArk(response);
  const env = environment();
  let acknowledge;
  env.AUTH.checkpointManagedText.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  );
  const ctx = context();
  const result = await worker.fetch(request(streamingBody), env, ctx);
  let received = false;
  const text = result.text().then((value) => {
    received = true;
    return value;
  });
  await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'));
  expect(received).toBe(false);
  acknowledge({ status: 'checkpointed' });
  expect(await text).toContain('[DONE]');
  await Promise.all(ctx.tasks);
});

it('keeps a long stream alive through persistent heartbeats and stops them at completion', async () => {
  vi.useFakeTimers();
  let source;
  stubArk(
    () =>
      new Response(
        new ReadableStream({
          start(c) {
            source = c;
            c.enqueue(new TextEncoder().encode(delta('')));
          },
        }),
      ),
  );
  const env = environment();
  const ctx = context();
  const response = await worker.fetch(request(streamingBody), env, ctx);
  const result = response.text();
  await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
  expect(env.AUTH.heartbeatManagedText).toHaveBeenCalledTimes(11);
  expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
  source.enqueue(new TextEncoder().encode(frame({ usage }) + 'data: [DONE]\n\n'));
  expect(await result).toContain('[DONE]');
  await Promise.all(ctx.tasks);
  await vi.advanceTimersByTimeAsync(60 * 1000);
  expect(env.AUTH.heartbeatManagedText).toHaveBeenCalledTimes(11);
});

it('stops an unconfirmed stream on heartbeat failure and retains its task for review', async () => {
  vi.useFakeTimers();
  const { response, cancel } = sseStream([delta('')]);
  stubArk(response);
  const env = environment();
  env.AUTH.heartbeatManagedText.mockRejectedValue(new Error('offline'));
  const ctx = context();
  const result = await worker.fetch(request(streamingBody), env, ctx);
  const rejected = expect(result.text()).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(60 * 1000);
  await rejected;
  await Promise.all(ctx.tasks);
  expect(cancel).toHaveBeenCalled();
  expect(env.AUTH.finalizeManagedText).not.toHaveBeenCalled();
});

it('passes explicit conversation/run identity to authenticated reservation without forwarding it to the model', async () => {
  const { calls } = stubArk(rawCompletion({ usage, choices: [] }));
  const env = environment();
  const input = request({ messages: [] });
  input.headers.set('X-0xNullAI-Conversation-Id', 'private-chat');
  input.headers.set('X-0xNullAI-Run-Id', 'run:actual:001');
  expect((await worker.fetch(input, env, context())).status).toBe(200);
  expect(env.AUTH.reserveCredits).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      context: { conversationId: 'private-chat', runId: 'run:actual:001' },
    }),
  );
  expect(JSON.stringify(calls)).not.toContain('private-chat');
});

it('rejects a foreign conversation before model generation without releasing a nonexistent hold', async () => {
  const { fetch } = stubArk(completion('never'));
  const env = environment();
  env.AUTH.reserveCredits.mockResolvedValue({ allowed: false, status: 'rejected' });
  const result = await worker.fetch(request({ messages: [] }), env, context());
  expect(result.status).toBe(403);
  expect(fetch).not.toHaveBeenCalled();
  expect(env.AUTH.finalizeManagedText).not.toHaveBeenCalled();
});

const visualJpeg =
  'data:image/jpeg;base64,' +
  Buffer.from([0xff, 0xd8, ...Array(8).fill(0), 0xff, 0xd9]).toString('base64');
function managedVisionRequest(url = visualJpeg, system) {
  const input = request({
    model: 'vision',
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Observe the frame.' },
          { type: 'image_url', image_url: { url, detail: 'auto' } },
        ],
      },
    ],
    max_tokens: 256,
  });
  input.headers.set('X-0xNullAI-Usage-Kind', 'video');
  input.headers.set('X-0xNullAI-Conversation-Id', 'private-chat');
  input.headers.set('X-0xNullAI-Run-Id', 'run:vision:001');
  return input;
}

describe('managed camera Credit', () => {
  it('routes frames to the vision route, binds conversation and body hash, then settles usage', async () => {
    const visionUsage = { prompt_tokens: 100, completion_tokens: 20 };
    const { calls } = stubArk(completion('I see a lamp.', visionUsage));
    const env = environment();
    const result = await worker.fetch(managedVisionRequest(), env, context());
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      model: 'vision',
      choices: [{ message: { content: 'I see a lamp.' } }],
      credit_charged: tokenCredits(table.vision, visionUsage),
    });
    const forwarded = calls[0].body;
    expect(forwarded.model).toBe(table.vision.model);
    expect(forwarded.thinking).toEqual({ type: 'disabled' });
    expect(forwarded.messages[0].content[1]).toEqual({
      type: 'image_url',
      image_url: { url: visualJpeg },
    });
    expect(JSON.stringify(forwarded)).not.toContain('private-chat');
    const reserved = env.AUTH.reserveCredits.mock.calls[0][1];
    expect(reserved).toMatchObject({
      usageKind: 'video',
      modelId: 'vision',
      credits: tokenReservation(
        table.vision,
        estimateInputTokens({ messages: forwarded.messages }),
        256,
      ),
      context: { conversationId: 'private-chat', runId: 'run:vision:001' },
      bodyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(env.AUTH.settleCredits).toHaveBeenCalledWith(
      expect.anything(),
      'request:test:001',
      tokenCredits(table.vision, visionUsage),
      expect.objectContaining({
        model: 'vision',
        upstreamModel: table.vision.model,
        requestHash: reserved.bodyHash,
        imageBytes: 12,
        usage: visionUsage,
      }),
    );
  });

  it('falls back on the vision route fallback only when one is configured', async () => {
    const { calls } = stubArk(arkError(503), completion('never'));
    const env = environment();
    const result = await worker.fetch(managedVisionRequest(), env, context());
    // The example vision route has no fallback: the explicit 503 releases the hold.
    expect(result.status).toBe(502);
    expect(calls).toHaveLength(1);
    expect(env.AUTH.releaseCredits).toHaveBeenCalledOnce();
  });

  it('rejects a remote frame, missing conversation or oversized prompt before reserving', async () => {
    const { fetch } = stubArk(completion('never'));
    const env = environment();
    const remote = await worker.fetch(
      managedVisionRequest('https://example.org/frame.jpg'),
      env,
      context(),
    );
    expect(remote.status).toBe(400);
    const missing = managedVisionRequest();
    missing.headers.delete('X-0xNullAI-Conversation-Id');
    expect((await worker.fetch(missing, env, context())).status).toBe(400);
    const oversized = managedVisionRequest(visualJpeg, 'x'.repeat(VISION_MAX_INPUT_TOKENS));
    expect((await worker.fetch(oversized, env, context())).status).toBe(413);
    expect(env.AUTH.reserveManagedTextCredits).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps unknown vision usage pending instead of charging or releasing', async () => {
    stubArk(completion('Done', null));
    const env = environment();
    const result = await worker.fetch(managedVisionRequest(), env, context());
    expect(result.status).toBe(502);
    expect(await result.json()).toMatchObject({ billing_status: 'pending' });
    expect(env.AUTH.settleCredits).not.toHaveBeenCalled();
    expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
  });

  it('does not settle a visual response that cannot be delivered as a valid result', async () => {
    stubArk(rawCompletion({ usage: { prompt_tokens: 100, completion_tokens: 1 } }));
    const env = environment();
    const result = await worker.fetch(managedVisionRequest(), env, context());
    expect(result.status).toBe(502);
    expect(await result.json()).toMatchObject({ billing_status: 'pending' });
    expect(env.AUTH.settleCredits).not.toHaveBeenCalled();
    expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
  });

  it('does not call the provider when the server balance cannot cover the hold', async () => {
    const { fetch } = stubArk(completion('never'));
    const env = environment();
    env.AUTH.reserveCredits.mockResolvedValue({ allowed: false, status: 'insufficient' });
    const result = await worker.fetch(managedVisionRequest(), env, context());
    expect(result.status).toBe(402);
    expect(fetch).not.toHaveBeenCalled();
  });
});

function managedChatVisionRequest() {
  const input = request({
    model: 'chat-vision',
    messages: [
      { role: 'system', content: '角色设定和经过授权的私人 Memory' },
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好，记得你喜欢咖啡。' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '这张图是什么？' },
          { type: 'image_url', image_url: { url: visualJpeg, detail: 'auto' } },
        ],
      },
    ],
    max_tokens: 256,
  });
  input.headers.set('X-0xNullAI-Usage-Kind', 'agent');
  input.headers.set('X-0xNullAI-Conversation-Id', 'private-chat');
  input.headers.set('X-0xNullAI-Run-Id', 'run:chat:001');
  return input;
}

describe('managed private chat image Credit', () => {
  it('is disabled and absent from the public catalog until explicitly enabled', async () => {
    const env = environment();
    expect((await worker.fetch(managedChatVisionRequest(), env, context())).status).toBe(403);
    expect(env.AUTH.reserveManagedTextCredits).not.toHaveBeenCalled();
    const models = await worker.fetch(modelsRequest(), env, context());
    expect((await models.json()).data.map((item) => item.id)).not.toContain('chat-vision');
    const enabled = await worker.fetch(
      modelsRequest(),
      environment({ ENABLE_CHAT_VISION: 'true' }),
      context(),
    );
    expect((await enabled.json()).data.map((item) => item.id)).toContain('chat-vision');
  });

  it('binds character chat context and full request hash to a vision-route hold', async () => {
    const { calls } = stubArk(
      completion('是一杯咖啡。', { prompt_tokens: 200, completion_tokens: 10 }),
    );
    const env = environment({ ENABLE_CHAT_VISION: 'true' });
    const response = await worker.fetch(managedChatVisionRequest(), env, context());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ model: 'chat-vision', credit_charged: 1 });
    const reserved = env.AUTH.reserveCredits.mock.calls[0][1];
    expect(reserved).toMatchObject({
      usageKind: 'agent',
      modelId: 'chat-vision',
      credits: tokenReservation(
        table.vision,
        estimateInputTokens({ messages: calls[0].body.messages }),
        256,
      ),
      context: { conversationId: 'private-chat', runId: 'run:chat:001' },
      bodyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(env.AUTH.settleCredits).toHaveBeenCalledWith(
      expect.anything(),
      'request:test:001',
      1,
      expect.objectContaining({
        model: 'chat-vision',
        requestHash: reserved.bodyHash,
        imageBytes: 12,
      }),
    );
    expect(calls[0].body.model).toBe(table.vision.model);
    expect(calls[0].body.messages[0].content).toBe('角色设定和经过授权的私人 Memory');
  });

  it('rejects streaming and wrong usage kind before reservation', async () => {
    const env = environment({ ENABLE_CHAT_VISION: 'true' });
    const streaming = managedChatVisionRequest();
    const body = await streaming.clone().json();
    const requestWithStream = request({ ...body, stream: true });
    requestWithStream.headers.set('X-0xNullAI-Usage-Kind', 'agent');
    requestWithStream.headers.set('X-0xNullAI-Conversation-Id', 'private-chat');
    requestWithStream.headers.set('X-0xNullAI-Run-Id', 'run:chat:001');
    expect((await worker.fetch(requestWithStream, env, context())).status).toBe(400);
    streaming.headers.set('X-0xNullAI-Usage-Kind', 'video');
    expect((await worker.fetch(streaming, env, context())).status).toBe(400);
    expect(env.AUTH.reserveManagedTextCredits).not.toHaveBeenCalled();
  });

  it('uses the chat route for a no-image tool continuation without replaying image data', async () => {
    const { calls } = stubArk(
      completion('设备已停止。', { prompt_tokens: 90, completion_tokens: 20 }),
    );
    const env = environment({ ENABLE_CHAT_VISION: 'true' });
    const followUp = request(
      {
        model: 'chat-vision',
        messages: [
          { role: 'system', content: '角色设定和私人 Memory' },
          { role: 'user', content: '请停止设备' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call:stop',
                type: 'function',
                function: { name: 'device_stop', arguments: '{}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call:stop', content: '已执行停止' },
        ],
      },
      'request:chat:followup',
    );
    followUp.headers.set('X-0xNullAI-Usage-Kind', 'agent');
    followUp.headers.set('X-0xNullAI-Conversation-Id', 'private-chat');
    followUp.headers.set('X-0xNullAI-Run-Id', 'run:chat:001');
    const response = await worker.fetch(followUp, env, context());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ credit_charged: 1 });
    expect(env.AUTH.reserveCredits.mock.calls[0][1]).toMatchObject({
      modelId: 'chat-vision',
      usageKind: 'agent',
    });
    expect(calls[0].body.model).toBe(table.chat.model);
    expect(env.AUTH.settleCredits.mock.calls[0][3]).toMatchObject({ imageBytes: 0 });
    expect(JSON.stringify(calls[0].body)).not.toContain('data:image');
  });
});

it('exports only handlers from the Worker entry, as the runtime requires', () => {
  for (const [name, value] of Object.entries(workerModule)) {
    if (name === 'default') continue;
    expect(typeof value, name).toBe('function');
  }
});
