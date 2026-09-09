/** Managed 0xNullAI model service. Every successful request consumes Credit. */

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_OUTPUT_TOKENS = 4096;
const PRICE_VERSION = 'credits-2026-09';

function allowedOrigins(env) {
  return new Set(
    String(env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
  );
}

function corsHeaders(origin, env) {
  const selected = origin && allowedOrigins(env).has(origin) ? origin : null;
  return {
    ...(selected ? { 'Access-Control-Allow-Origin': selected } : {}),
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, Idempotency-Key, X-0xNullAI-Usage-Kind',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    Vary: 'Origin',
  };
}

function json(status, data, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function readJsonBounded(request) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function credentials(request) {
  return {
    authorization: request.headers.get('Authorization'),
    cookie: request.headers.get('Cookie'),
  };
}

function model(env) {
  return {
    id: 'balanced',
    object: 'model',
    name: '均衡',
    upstreamId: env.UPSTREAM_MODEL,
    inputCreditsPerMillion: Number(env.INPUT_CREDITS_PER_MILLION),
    cachedInputCreditsPerMillion: Number(env.CACHED_INPUT_CREDITS_PER_MILLION),
    outputCreditsPerMillion: Number(env.OUTPUT_CREDITS_PER_MILLION),
    imageInput: true,
    priceVersion: PRICE_VERSION,
  };
}

function validModelConfig(item) {
  return (
    typeof item.upstreamId === 'string' &&
    item.upstreamId.length > 0 &&
    Number.isFinite(item.inputCreditsPerMillion) &&
    item.inputCreditsPerMillion > 0 &&
    Number.isFinite(item.outputCreditsPerMillion) &&
    item.outputCreditsPerMillion > 0
  );
}

function estimateInputTokens(body) {
  // UTF-8 bytes are a deliberately conservative tokenizer-independent upper
  // bound for supported text. Reservations are temporary; settlement uses the
  // upstream's actual token counts.
  return Math.max(1, new TextEncoder().encode(JSON.stringify(body.messages ?? [])).byteLength);
}

function estimateReservation(body, item) {
  const maxOutput = Math.min(
    Math.max(Math.trunc(Number(body.max_tokens) || 1024), 1),
    MAX_OUTPUT_TOKENS,
  );
  const input = estimateInputTokens(body);
  return Math.max(
    1,
    Math.ceil(
      (input * item.inputCreditsPerMillion + maxOutput * item.outputCreditsPerMillion) / 1_000_000,
    ),
  );
}

function chargedCredits(usage, item) {
  const prompt = Math.max(0, Math.trunc(Number(usage?.prompt_tokens) || 0));
  const cached = Math.min(
    prompt,
    Math.max(0, Math.trunc(Number(usage?.prompt_tokens_details?.cached_tokens) || 0)),
  );
  const completion = Math.max(0, Math.trunc(Number(usage?.completion_tokens) || 0));
  const raw =
    (prompt - cached) * item.inputCreditsPerMillion +
    cached * (item.cachedInputCreditsPerMillion || item.inputCreditsPerMillion) +
    completion * item.outputCreditsPerMillion;
  return Math.max(1, Math.ceil(raw / 1_000_000));
}

async function withinRateLimit(env, request) {
  if (!env.RATE_LIMITER || typeof env.RATE_LIMITER.limit !== 'function') return false;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  try {
    return (await env.RATE_LIMITER.limit({ key: ip })).success;
  } catch {
    return false;
  }
}

async function relayAndSettle(upstream, auth, key, item, env) {
  const reader = upstream.body.getReader();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const decoder = new TextDecoder();
  let buffer = '';
  let usage = null;
  const completion = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value);
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const event = JSON.parse(payload);
            if (event.usage) usage = event.usage;
          } catch {
            // Ignore upstream SSE comments and optional non-JSON events.
          }
        }
      }
      if (!usage) throw new Error('upstream stream did not report usage');
      await env.AUTH.settleCredits(auth, key, chargedCredits(usage, item), {
        model: item.id,
        upstreamModel: item.upstreamId,
        usage,
        priceVersion: PRICE_VERSION,
      });
      await writer.close();
    } catch (error) {
      await env.AUTH.releaseCredits(auth, key);
      await writer.abort(error);
    } finally {
      reader.releaseLock();
    }
  })();
  return { readable: stream.readable, completion };
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin, env);
    if (origin && !allowedOrigins(env).has(origin)) return json(403, { error: '来源不被允许' });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    const item = model(env);
    if (!validModelConfig(item)) return json(503, { error: '平台模型尚未配置' }, cors);

    if (url.pathname === '/v1/models' && request.method === 'GET') {
      const balance = await env.AUTH.creditBalance(credentials(request));
      if (balance === 'unauthorized') return json(401, { error: '请先登录' }, cors);
      const publicModel = { ...item };
      delete publicModel.upstreamId;
      return json(200, { object: 'list', data: [publicModel], credit: balance }, cors);
    }

    if (url.pathname !== '/v1/chat/completions' || request.method !== 'POST') {
      return json(404, { error: '接口不存在' }, cors);
    }
    if (!(await withinRateLimit(env, request))) return json(429, { error: '请求过于频繁' }, cors);

    let body;
    try {
      body = await readJsonBounded(request);
    } catch {
      return json(400, { error: '请求体格式错误' }, cors);
    }
    if (!body) return json(413, { error: '请求体过大' }, cors);
    if (!Array.isArray(body.messages)) return json(400, { error: 'messages 格式错误' }, cors);

    const key = request.headers.get('Idempotency-Key');
    if (!key) return json(400, { error: '缺少 Idempotency-Key' }, cors);
    const auth = credentials(request);
    const reservation = await env.AUTH.reserveCredits(auth, {
      idempotencyKey: key,
      usageKind: request.headers.get('X-0xNullAI-Usage-Kind') === 'video' ? 'video' : 'agent',
      modelId: item.id,
      credits: estimateReservation(body, item),
    });
    if (reservation === 'unauthorized') return json(401, { error: '请先登录' }, cors);
    if (!reservation.allowed) {
      const status = reservation.status === 'insufficient' ? 402 : 409;
      return json(
        status,
        {
          error: status === 402 ? 'Credit 不足' : '该请求已经提交，请勿重复发送',
          credit: reservation,
        },
        cors,
      );
    }

    const upstreamBody = {
      ...body,
      model: item.upstreamId,
      max_tokens: Math.min(
        Math.max(Math.trunc(Number(body.max_tokens) || 1024), 1),
        MAX_OUTPUT_TOKENS,
      ),
      ...(body.stream ? { stream_options: { include_usage: true } } : {}),
    };
    delete upstreamBody.api_key;
    delete upstreamBody.apiKey;

    let upstream;
    try {
      upstream = await fetch(
        `${String(env.UPSTREAM_BASE_URL).replace(/\/+$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.PROXY_API_KEY}`,
          },
          body: JSON.stringify(upstreamBody),
        },
      );
    } catch {
      await env.AUTH.releaseCredits(auth, key);
      return json(502, { error: '模型服务暂时不可用' }, cors);
    }
    if (!upstream.ok) {
      await env.AUTH.releaseCredits(auth, key);
      return json(upstream.status >= 500 ? 502 : upstream.status, { error: '模型请求失败' }, cors);
    }

    if (body.stream) {
      if (!upstream.body) {
        await env.AUTH.releaseCredits(auth, key);
        return json(502, { error: '模型流不可用' }, cors);
      }
      const relay = await relayAndSettle(upstream, auth, key, item, env);
      ctx.waitUntil(relay.completion);
      return new Response(relay.readable, {
        status: 200,
        headers: { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' },
      });
    }

    try {
      const payload = await upstream.json();
      if (!payload?.usage) throw new Error('missing usage');
      const charged = chargedCredits(payload.usage, item);
      await env.AUTH.settleCredits(auth, key, charged, {
        model: item.id,
        upstreamModel: item.upstreamId,
        usage: payload.usage,
        priceVersion: PRICE_VERSION,
      });
      return json(200, { ...payload, model: item.id, credit_charged: charged }, cors);
    } catch {
      await env.AUTH.releaseCredits(auth, key);
      return json(502, { error: '模型响应缺少可结算用量' }, cors);
    }
  },
};

export { chargedCredits, estimateReservation };
