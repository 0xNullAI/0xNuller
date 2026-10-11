import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { MODELS, chargedCredits, estimateReservation } from './index.js';

const model = MODELS.find((item) => item.id === 'balanced');
const powerfulModel = MODELS.find((item) => item.id === 'powerful');

function environment(overrides = {}) {
  const env = {
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
      settleCredits: vi.fn().mockResolvedValue({ status: 'settled', charged: 1 }),
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

afterEach(() => vi.unstubAllGlobals());

describe('Credit 价格', () => {
  it('提供三个文字档位与两个相互隔离的视觉协议', () => {
    expect(MODELS.map((item) => item.id)).toEqual([
      'basic',
      'balanced',
      'powerful',
      'vision',
      'chat-vision',
    ]);
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
    const models = await worker.fetch(
      new Request('https://llm.0xnullai.com/v1/models', {
        headers: { Origin: 'https://0xnullai.com' },
      }),
      env,
      context(),
    );
    expect((await models.json()).data.map((item) => item.id)).not.toContain('chat-vision');
  });

  it('binds character chat context and full request hash to an independent 59 Credit hold', async () => {
    const env = environment({
      ENABLE_CHAT_VISION: 'true',
      AI: {
        run: vi.fn().mockResolvedValue({
          response: '是一杯咖啡。',
          usage: { prompt_tokens: 200, completion_tokens: 10 },
        }),
      },
    });
    const response = await worker.fetch(managedChatVisionRequest(), env, context());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ model: 'chat-vision', credit_charged: 1 });
    const reserved = env.AUTH.reserveCredits.mock.calls[0][1];
    expect(reserved).toMatchObject({
      usageKind: 'agent',
      modelId: 'chat-vision',
      credits: 59,
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
    expect(env.AI.run.mock.calls[0][1].messages[0].content).toBe('角色设定和经过授权的私人 Memory');
    expect(JSON.stringify(env.AI.run.mock.calls[0][1])).not.toContain('private-chat');
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

  it('does not run without sufficient Credit or settle untrusted upstream usage', async () => {
    const insufficient = environment({ ENABLE_CHAT_VISION: 'true' });
    insufficient.AUTH.reserveCredits.mockResolvedValue({ allowed: false, status: 'insufficient' });
    expect((await worker.fetch(managedChatVisionRequest(), insufficient, context())).status).toBe(
      402,
    );
    expect(insufficient.AI.run).not.toHaveBeenCalled();

    const missingUsage = environment({
      ENABLE_CHAT_VISION: 'true',
      AI: { run: vi.fn().mockResolvedValue({ response: '可能是一杯咖啡' }) },
    });
    const response = await worker.fetch(managedChatVisionRequest(), missingUsage, context());
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ billing_status: 'pending' });
    expect(missingUsage.AUTH.settleCredits).not.toHaveBeenCalled();
    expect(missingUsage.AUTH.releaseCredits).not.toHaveBeenCalled();
  });

  it('settles a no-image tool continuation as a separate agent request without replaying image data', async () => {
    const env = environment({
      ENABLE_CHAT_VISION: 'true',
      AI: {
        run: vi.fn().mockResolvedValue({
          response: '设备已停止。',
          usage: { prompt_tokens: 90, completion_tokens: 20 },
        }),
      },
    });
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
      credits: 59,
    });
    expect(env.AUTH.settleCredits.mock.calls[0][3]).toMatchObject({ imageBytes: 0 });
    expect(JSON.stringify(env.AI.run.mock.calls[0][1])).not.toContain('data:image');
  });
});

describe('平台模型请求', () => {
  it('uses a signed group reservation and payer context, never browser credentials', async () => {
    const env = environment({
      AI: {
        run: vi.fn().mockResolvedValue({
          choices: [{ message: { content: '群聊回复' } }],
          usage: { prompt_tokens: 20, completion_tokens: 10 },
        }),
      },
    });
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
      { waitUntil: vi.fn() },
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
  });

  it('does not invoke the model when the triggering member lacks Credit', async () => {
    const env = environment();
    env.AUTH.reserveManagedGroupTextCredits = vi
      .fn()
      .mockResolvedValue({ allowed: false, status: 'insufficient' });
    const response = await worker.fetch(groupRequest({ messages: [] }), env, {
      waitUntil: vi.fn(),
    });
    expect(response.status).toBe(402);
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it('rejects an invalid group ticket before limiter, reservation or model call', async () => {
    const env = environment();
    env.AUTH.authorizeManagedGroupText.mockResolvedValue('unauthorized');
    const response = await worker.fetch(groupRequest({ messages: [] }), env, {
      waitUntil: vi.fn(),
    });
    expect(response.status).toBe(401);
    expect(env.RATE_LIMITER.limit).not.toHaveBeenCalled();
    expect(env.AUTH.reserveManagedGroupTextCredits).toBeUndefined();
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it('rejects group streaming and tools before any reservation', async () => {
    const env = environment();
    const response = await worker.fetch(groupRequest({ messages: [], tools: [] }), env, {
      waitUntil: vi.fn(),
    });
    expect(response.status).toBe(400);
    expect(env.AUTH.reserveManagedTextCredits).not.toHaveBeenCalled();
  });
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

  it('上游调用失败但执行状态未知时保留冻结待核对', async () => {
    const env = environment({
      AI: { run: vi.fn().mockRejectedValue(new Error('model unavailable')) },
    });
    const response = await worker.fetch(
      request({ messages: [{ role: 'user', content: 'hello' }] }),
      env,
      { waitUntil: vi.fn() },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ billing_status: 'pending' });
    expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
  });
});

function streamEnvironment(chunks, cancel = vi.fn()) {
  const source = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
    },
    cancel,
  });
  return { env: environment({ AI: { run: vi.fn().mockResolvedValue(source) } }), cancel };
}
function context() {
  const tasks = [];
  return { tasks, waitUntil: (promise) => tasks.push(promise) };
}
const usage = { prompt_tokens: 1000, completion_tokens: 100 };
const streamingBody = {
  stream: true,
  model: 'balanced',
  messages: [{ role: 'user', content: 'hello' }],
};
describe('managed response billing boundaries', () => {
  it('counts tool schemas when reserving maximum possible input', () => {
    const base = { messages: [], max_tokens: 1 };
    expect(
      estimateReservation(
        { ...base, tools: [{ function: { description: 'x'.repeat(100000) } }] },
        powerfulModel,
      ),
    ).toBeGreaterThan(estimateReservation(base, powerfulModel));
  });
  it('retries an ambiguous settlement with the same key and never switches to release', async () => {
    const env = environment({ AI: { run: vi.fn().mockResolvedValue({ usage, choices: [] }) } });
    env.AUTH.settleCredits
      .mockRejectedValueOnce(new Error('reply lost after commit'))
      .mockResolvedValue({ status: 'settled', charged: 1 });
    const result = await worker.fetch(request({ messages: [] }), env, context());
    expect(result.status).toBe(200);
    expect(env.AUTH.settleCredits).toHaveBeenCalledTimes(2);
    expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
  });
  it('does not claim payment success or release after permanently ambiguous settlement', async () => {
    const env = environment({ AI: { run: vi.fn().mockResolvedValue({ usage, choices: [] }) } });
    env.AUTH.settleCredits.mockRejectedValue(new Error('unreachable'));
    const result = await worker.fetch(request({ messages: [] }), env, context());
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({ billing_status: 'pending' });
    expect(env.AUTH.settleCredits).toHaveBeenCalledTimes(3);
    expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
  });
  it('checks actual terminal states and rejects invalid usage rather than charging minimum by accident', async () => {
    const env = environment({ AI: { run: vi.fn().mockResolvedValue({ usage, choices: [] }) } });
    env.AUTH.settleCredits.mockResolvedValue({ status: 'released', charged: null });
    const result = await worker.fetch(request({ messages: [] }), env, context());
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({ billing_status: 'released' });
    expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
    env.AI.run.mockResolvedValue({ usage: { prompt_tokens: -1, completion_tokens: 'junk' } });
    const invalid = await worker.fetch(request({ messages: [] }), env, context());
    expect(invalid.status).toBe(502);
    expect(await invalid.json()).toMatchObject({ billing_status: 'pending' });
    expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
    expect(env.AUTH.settleCredits).toHaveBeenCalledOnce();
  });
  it('keeps a completed but unmetered response for review instead of releasing its hold', async () => {
    const env = environment({ AI: { run: vi.fn().mockResolvedValue({ choices: [] }) } });
    const result = await worker.fetch(request({ messages: [] }), env, context());
    expect(result.status).toBe(502);
    expect(await result.json()).toMatchObject({ billing_status: 'pending' });
    expect(env.AUTH.finalizeManagedText).not.toHaveBeenCalled();
    expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
  });
  it('keeps an ambiguous invocation failure pending for review', async () => {
    const env = environment({ AI: { run: vi.fn().mockRejectedValue(new Error('upstream')) } });
    const result = await worker.fetch(request({ messages: [] }), env, context());
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({ billing_status: 'pending' });
    expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
    expect(env.AUTH.finalizeManagedText).not.toHaveBeenCalled();
  });
  it('releases only an explicit rejected upstream response with no result', async () => {
    const env = environment({
      AI: { run: vi.fn().mockResolvedValue(new Response('rejected', { status: 400 })) },
    });
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
    const env = environment({ AI: { run: vi.fn().mockResolvedValue(source) } });
    const ctx = context();
    const result = await worker.fetch(request(streamingBody), env, ctx);
    expect(await result.text()).toContain('prompt_tokens');
    await Promise.all(ctx.tasks);
    expect(env.AUTH.settleCredits).toHaveBeenCalledOnce();
    expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
  });
  it('withholds DONE until settlement is acknowledged', async () => {
    const source = new ReadableStream({
      start(c) {
        c.enqueue(
          new TextEncoder().encode('data: ' + JSON.stringify({ usage }) + '\n\ndata: [DONE]\n\n'),
        );
        c.close();
      },
    });
    let resolve;
    const settled = new Promise((r) => {
      resolve = r;
    });
    const env = environment({ AI: { run: vi.fn().mockResolvedValue(source) } });
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
    const { env, cancel } = streamEnvironment([
      'data: {"choices":[]}\n\ndata: ' + JSON.stringify({ usage }) + '\n\n',
    ]);
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
    const { env, cancel } = streamEnvironment(['data: {"choices":[]}\n\n']);
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
    const source = new ReadableStream({
      start(c) {
        c.enqueue(
          new TextEncoder().encode('data: ' + JSON.stringify({ usage }) + '\n\ndata: [DONE]\n\n'),
        );
        c.close();
      },
    });
    const env = environment({ AI: { run: vi.fn().mockResolvedValue(source) } });
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
    const env = environment();
    env.AUTH.reserveCredits.mockResolvedValue({ allowed: false, status: 'pending' });
    const response = await worker.fetch(request({ messages: [] }), env, context());
    expect(response.status).toBe(409);
    expect(env.AI.run).not.toHaveBeenCalled();
    expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
  });
  it('bounds settlement RPC deadlines and retains the original settle action', async () => {
    vi.useFakeTimers();
    try {
      const env = environment({ AI: { run: vi.fn().mockResolvedValue({ usage }) } });
      env.AUTH.settleCredits.mockImplementation(() => new Promise(() => {}));
      const pending = worker.fetch(request({ messages: [] }), env, context());
      await vi.advanceTimersByTimeAsync(9100);
      const response = await pending;
      expect(response.status).toBe(503);
      expect(env.AUTH.settleCredits).toHaveBeenCalledTimes(3);
      expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it('aborts a blocked upstream when the request signal is cancelled', async () => {
    const controller = new AbortController();
    const { env, cancel } = streamEnvironment([]);
    const ctx = context();
    const original = request(streamingBody);
    const response = await worker.fetch(
      new Request(original, { signal: controller.signal }),
      env,
      ctx,
    );
    controller.abort();
    await expect(response.text()).rejects.toThrow();
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
      if (read++ === 0)
        c.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ usage }) + '\n\n'));
      else c.error(new Error('upstream interrupted'));
    },
  });
  const env = environment({ AI: { run: vi.fn().mockResolvedValue(source) } });
  const ctx = context();
  const response = await worker.fetch(request(streamingBody), env, ctx);
  await expect(response.text()).rejects.toThrow();
  await Promise.all(ctx.tasks);
  expect(env.AUTH.settleCredits).toHaveBeenCalledOnce();
  expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
});
it('keeps a provider stream whose reader cannot be acquired pending for review', async () => {
  const source = new ReadableStream();
  const locked = source.getReader();
  const env = environment({ AI: { run: vi.fn().mockResolvedValue(source) } });
  const response = await worker.fetch(request(streamingBody), env, context());
  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({ billing_status: 'pending' });
  expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
  expect(env.AUTH.finalizeManagedText).not.toHaveBeenCalled();
  locked.releaseLock();
});

it('finalizes at DONE without waiting for EOF and ignores usage after termination', async () => {
  const { env, cancel } = streamEnvironment([
    'data: ' +
      JSON.stringify({ usage }) +
      '\n\ndata: [DONE]\n\n' +
      'data: ' +
      JSON.stringify({ usage: { prompt_tokens: 100000, completion_tokens: 100000 } }) +
      '\n\n',
  ]);
  const ctx = context();
  const response = await worker.fetch(request(streamingBody), env, ctx);
  const text = await response.text();
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
  const { env } = streamEnvironment([
    'data: [DONE]\n\ndata: ' + JSON.stringify({ usage }) + '\n\n',
  ]);
  const ctx = context();
  const response = await worker.fetch(request(streamingBody), env, ctx);
  await expect(response.text()).rejects.toThrow('valid usage');
  await Promise.all(ctx.tasks);
  expect(env.AUTH.settleCredits).not.toHaveBeenCalled();
  expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
  expect(env.AUTH.finalizeManagedText).not.toHaveBeenCalled();
});

it.each([null, { allowed: true, status: 'settled' }, { allowed: 'yes', status: 'pending' }])(
  'fails closed on an invalid reserve acknowledgement %j',
  async (acknowledgement) => {
    const env = environment();
    env.AUTH.reserveCredits.mockResolvedValue(acknowledgement);
    const response = await worker.fetch(request({ messages: [] }), env, context());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ billing_status: 'unknown' });
    expect(env.AI.run).not.toHaveBeenCalled();
    expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
  },
);

it('bounds ambiguous reserve and leaves a repeated pending key untouched', async () => {
  vi.useFakeTimers();
  try {
    const env = environment();
    env.AUTH.reserveCredits.mockImplementationOnce(() => new Promise(() => {}));
    const pending = worker.fetch(request({ messages: [] }), env, context());
    await vi.advanceTimersByTimeAsync(3100);
    expect((await pending).status).toBe(503);
    env.AUTH.reserveCredits.mockResolvedValue({ allowed: false, status: 'pending' });
    const repeated = await worker.fetch(request({ messages: [] }), env, context());
    expect(repeated.status).toBe(409);
    expect(env.AI.run).not.toHaveBeenCalled();
    expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
    expect(env.AUTH.settleCredits).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it('fails closed when durable usage cannot be acknowledged, without changing to release', async () => {
  const env = environment({ AI: { run: vi.fn().mockResolvedValue({ usage, choices: [] }) } });
  env.AUTH.checkpointManagedText.mockRejectedValue(new Error('D1 unavailable'));
  const response = await worker.fetch(request({ messages: [] }), env, context());
  expect(response.status).toBe(503);
  expect(env.AUTH.checkpointManagedText).toHaveBeenCalledTimes(3);
  expect(env.AUTH.finalizeManagedText).not.toHaveBeenCalled();
  expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
});

it('settles by reservation capability even when the original browser credentials have expired', async () => {
  const env = environment({ AI: { run: vi.fn().mockResolvedValue({ usage, choices: [] }) } });
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
  const { env } = streamEnvironment([
    'data: ' + JSON.stringify({ usage }) + '\n\ndata: [DONE]\n\n',
  ]);
  let acknowledge;
  env.AUTH.checkpointManagedText.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  );
  const ctx = context();
  const response = await worker.fetch(request(streamingBody), env, ctx);
  let received = false;
  const text = response.text().then((value) => {
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
  try {
    let source;
    const env = environment({
      AI: {
        run: vi.fn().mockResolvedValue(
          new ReadableStream({
            start(c) {
              source = c;
            },
          }),
        ),
      },
    });
    const ctx = context();
    const response = await worker.fetch(request(streamingBody), env, ctx);
    const result = response.text();
    await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
    expect(env.AUTH.heartbeatManagedText).toHaveBeenCalledTimes(11);
    expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
    source.enqueue(
      new TextEncoder().encode('data: ' + JSON.stringify({ usage }) + '\n\ndata: [DONE]\n\n'),
    );
    expect(await result).toContain('[DONE]');
    await Promise.all(ctx.tasks);
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(env.AUTH.heartbeatManagedText).toHaveBeenCalledTimes(11);
  } finally {
    vi.useRealTimers();
  }
});
it('stops an unconfirmed stream on heartbeat failure and retains its task for review', async () => {
  vi.useFakeTimers();
  try {
    const { env, cancel } = streamEnvironment([]);
    env.AUTH.heartbeatManagedText.mockRejectedValue(new Error('offline'));
    const ctx = context();
    const response = await worker.fetch(request(streamingBody), env, ctx);
    const rejected = expect(response.text()).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(60 * 1000);
    await rejected;
    await Promise.all(ctx.tasks);
    expect(cancel).toHaveBeenCalled();
    expect(env.AUTH.finalizeManagedText).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it('passes explicit conversation/run identity to authenticated reservation without forwarding it to the model', async () => {
  const env = environment({ AI: { run: vi.fn().mockResolvedValue({ usage, choices: [] }) } });
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
  expect(JSON.stringify(env.AI.run.mock.calls)).not.toContain('private-chat');
});

it('rejects a foreign conversation before model generation without releasing a nonexistent hold', async () => {
  const env = environment();
  env.AUTH.reserveCredits.mockResolvedValue({ allowed: false, status: 'rejected' });
  const result = await worker.fetch(request({ messages: [] }), env, context());
  expect(result.status).toBe(403);
  expect(env.AI.run).not.toHaveBeenCalled();
  expect(env.AUTH.finalizeManagedText).not.toHaveBeenCalled();
});

const visualJpeg =
  'data:image/jpeg;base64,' +
  Buffer.from([0xff, 0xd8, ...Array(8).fill(0), 0xff, 0xd9]).toString('base64');
function managedVisionRequest(url = visualJpeg) {
  const input = request({
    model: 'vision',
    messages: [
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
  it('reserves the server quote with bound conversation and body hash, then settles actual usage', async () => {
    const env = environment({
      AI: {
        run: vi.fn().mockResolvedValue({
          response: 'I see a lamp.',
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }),
      },
    });
    const result = await worker.fetch(managedVisionRequest(), env, context());
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      model: 'vision',
      choices: [{ message: { content: 'I see a lamp.' } }],
      credit_charged: 1,
    });
    expect(env.AUTH.reserveCredits).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        usageKind: 'video',
        modelId: 'vision',
        credits: 59,
        context: { conversationId: 'private-chat', runId: 'run:vision:001' },
        bodyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    const reserved = env.AUTH.reserveCredits.mock.calls[0][1];
    expect(env.AUTH.settleCredits).toHaveBeenCalledWith(
      expect.anything(),
      'request:test:001',
      1,
      expect.objectContaining({
        model: 'vision',
        requestHash: reserved.bodyHash,
        imageBytes: 12,
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }),
    );
    const forwarded = env.AI.run.mock.calls[0][1];
    expect(forwarded.messages[0].content[1]).toEqual({
      type: 'image_url',
      image_url: { url: visualJpeg },
    });
    expect(JSON.stringify(forwarded)).not.toContain('private-chat');
  });

  it('rejects a remote frame or missing conversation before reserving or invoking the model', async () => {
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
    expect(env.AUTH.reserveManagedTextCredits).not.toHaveBeenCalled();
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it('keeps unknown vision usage pending instead of charging or releasing', async () => {
    const env = environment({ AI: { run: vi.fn().mockResolvedValue({ response: 'Done' }) } });
    const result = await worker.fetch(managedVisionRequest(), env, context());
    expect(result.status).toBe(502);
    expect(await result.json()).toMatchObject({ billing_status: 'pending' });
    expect(env.AUTH.settleCredits).not.toHaveBeenCalled();
    expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
  });

  it('does not settle a visual response that cannot be delivered as a valid result', async () => {
    const env = environment({
      AI: {
        run: vi.fn().mockResolvedValue({ usage: { prompt_tokens: 100, completion_tokens: 1 } }),
      },
    });
    const result = await worker.fetch(managedVisionRequest(), env, context());
    expect(result.status).toBe(502);
    expect(await result.json()).toMatchObject({ billing_status: 'pending' });
    expect(env.AUTH.settleCredits).not.toHaveBeenCalled();
    expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
  });

  it.each([
    { prompt_tokens: 131_001, completion_tokens: 1 },
    { prompt_tokens: 1, completion_tokens: 4_097 },
  ])('keeps out-of-contract usage pending for review: %j', async (reportedUsage) => {
    const env = environment({
      AI: { run: vi.fn().mockResolvedValue({ response: 'Done', usage: reportedUsage }) },
    });
    const result = await worker.fetch(managedVisionRequest(), env, context());
    expect(result.status).toBe(502);
    expect(await result.json()).toMatchObject({ billing_status: 'pending' });
    expect(env.AUTH.settleCredits).not.toHaveBeenCalled();
    expect(env.AUTH.releaseCredits).not.toHaveBeenCalled();
  });

  it('does not call the provider when the server balance cannot cover the 59 Credit hold', async () => {
    const env = environment();
    env.AUTH.reserveCredits.mockResolvedValue({ allowed: false, status: 'insufficient' });
    const result = await worker.fetch(managedVisionRequest(), env, context());
    expect(result.status).toBe(402);
    expect(env.AI.run).not.toHaveBeenCalled();
  });
});
