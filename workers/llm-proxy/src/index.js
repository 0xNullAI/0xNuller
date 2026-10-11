import { billingHeartbeat } from './billing-heartbeat.js';
import { finalizeBilling, validUsage } from './billing.js';
import {
  VISION_MAX_RESERVATION_CREDITS,
  VISION_CONTEXT_TOKENS,
  VISION_MAX_OUTPUT_TOKENS,
  VISION_MODEL,
  CHAT_VISION_MODEL,
  normalizeVisionResult,
  prepareVisionRequest,
  requestHash,
} from './vision.js';
/** Managed 0xNullAI model service. Every successful request consumes Credit. */

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_OUTPUT_TOKENS = 4096;
const PRICE_VERSION = 'workers-ai-credits-2026-09';

// Public ids stay stable even when Cloudflare replaces a hosted model. Credit
// prices are the current Workers AI token prices multiplied by the product's
// established 1.5x conversion (USD per million tokens × 1500 Credit).
const MODELS = [
  {
    id: 'basic',
    name: '基础',
    description: '轻量实用，适合日常聊天和简单操作',
    upstreamId: '@cf/google/gemma-4-26b-a4b-it',
    inputCreditsPerMillion: 150,
    cachedInputCreditsPerMillion: 150,
    outputCreditsPerMillion: 450,
  },
  {
    id: 'balanced',
    name: '均衡',
    description: '质量与价格平衡，适合多数 Agent 任务',
    upstreamId: '@cf/zai-org/glm-4.7-flash',
    inputCreditsPerMillion: 90.75,
    cachedInputCreditsPerMillion: 90.75,
    outputCreditsPerMillion: 600,
  },
  {
    id: 'powerful',
    name: '强力',
    description: '适合复杂推理、长任务和多步工具调用',
    upstreamId: '@cf/zai-org/glm-5.3-flash',
    inputCreditsPerMillion: 225,
    cachedInputCreditsPerMillion: 45,
    outputCreditsPerMillion: 750,
  },
  VISION_MODEL,
  CHAT_VISION_MODEL,
];
const DEFAULT_MODEL_ID = 'balanced';

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
      'Content-Type, Authorization, Idempotency-Key, X-0xNullAI-Usage-Kind, X-0xNullAI-Conversation-Id, X-0xNullAI-Run-Id',
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

function publicModel(item) {
  return {
    id: item.id,
    object: 'model',
    name: item.name,
    description: item.description,
    inputCreditsPerMillion: item.inputCreditsPerMillion,
    cachedInputCreditsPerMillion: item.cachedInputCreditsPerMillion,
    outputCreditsPerMillion: item.outputCreditsPerMillion,
    imageInput: item.imageInput === true,
    ...(item.imageInput ? { maxReservationCredits: VISION_MAX_RESERVATION_CREDITS } : {}),
    priceVersion: PRICE_VERSION,
  };
}

function selectedModel(id) {
  return MODELS.find((item) => item.id === id) ?? null;
}

function estimateInputTokens(body) {
  // UTF-8 bytes are a deliberately conservative tokenizer-independent upper
  // bound for supported text. Reservations are temporary; settlement uses the
  // upstream's actual token counts.
  return Math.max(
    1,
    new TextEncoder().encode(
      JSON.stringify({
        messages: body.messages ?? [],
        tools: body.tools,
        tool_choice: body.tool_choice,
        response_format: body.response_format,
      }),
    ).byteLength,
  );
}

function estimateReservation(body, item) {
  if (item.imageInput) return VISION_MAX_RESERVATION_CREDITS;
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

async function withinRateLimit(env, request, verifiedGroupPayer) {
  if (!env.RATE_LIMITER || typeof env.RATE_LIMITER.limit !== 'function') return false;
  const key = verifiedGroupPayer
    ? `group-payer:${verifiedGroupPayer}`
    : request.headers.get('CF-Connecting-IP') || 'unknown';
  try {
    return (await env.RATE_LIMITER.limit({ key })).success;
  } catch {
    return false;
  }
}

function usageMetadata(usage, item, groupContext, visionContext) {
  return {
    model: item.id,
    upstreamModel: item.upstreamId,
    usage,
    priceVersion: PRICE_VERSION,
    ...(groupContext ? { groupContext } : {}),
    ...(visionContext ? visionContext : {}),
  };
}
async function sha256Body(body) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}
async function releaseAfterFailure(env, auth, key) {
  try {
    await finalizeBilling(env, auth, key, 'release');
    return 'released';
  } catch (error) {
    console.error('Managed billing release not acknowledged');
    return error.status ?? 'pending';
  }
}
async function relayAndSettle(upstreamBody, auth, key, item, env, signal, finishHeartbeat) {
  const reader = upstreamBody.getReader();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let usage = null;
  let terminal = false;
  let downstreamClosed = false;
  // Consumer cancellation must also unblock a reader waiting on an upstream chunk.
  void writer.closed.catch(() => {
    downstreamClosed = true;
    void reader.cancel().catch(() => {});
  });
  const abort = () => {
    downstreamClosed = true;
    void reader.cancel().catch(() => {});
    void writer.abort(new Error('request_cancelled')).catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const consume = async (frame) => {
    if (terminal) return null;
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (data === '[DONE]') {
      terminal = true;
      return null;
    }
    if (data) {
      try {
        const event = JSON.parse(data);
        if (validUsage(event.usage)) {
          usage = event.usage;
        }
      } catch {
        /* Non-JSON SSE remains pass-through. */
      }
    }
    if (usage) await env.AUTH.checkpoint(chargedCredits(usage, item), usageMetadata(usage, item));
    // Account usage before the write, which may reject when the browser disconnects.
    return encoder.encode(frame + '\n\n');
  };
  const completion = (async () => {
    let transportError = null;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          if (buffer.trim()) {
            const encoded = await consume(buffer);
            if (encoded && !downstreamClosed) await writer.write(encoded);
          }
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 256 * 1024) throw new Error('upstream_sse_frame_too_large');
        let separator;
        const frames = [];
        while ((separator = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, separator.index);
          buffer = buffer.slice(separator.index + separator[0].length);
          const encoded = await consume(frame);
          if (encoded) frames.push(encoded);
        }
        if (terminal) void reader.cancel().catch(() => {});
        for (const frame of frames) {
          if (!downstreamClosed) await writer.write(frame);
        }
        if (terminal) break;
      }
      if (!usage) throw new Error('upstream stream did not report valid usage');
    } catch (error) {
      transportError = error;
      void reader.cancel().catch(() => {});
    } finally {
      reader.releaseLock();
      finishHeartbeat();
    }
    try {
      if (!usage) {
        // The upstream may already have performed paid inference. Without
        // trusted usage, leave the durable hold for Auth's review recovery.
        await writer.abort(transportError ?? new Error('missing_valid_usage')).catch(() => {});
        return;
      }
      await finalizeBilling(
        env,
        auth,
        key,
        'settle',
        chargedCredits(usage, item),
        usageMetadata(usage, item),
      );
      if (transportError) {
        await writer.abort(transportError).catch(() => {});
        return;
      }
      if (terminal && !downstreamClosed) await writer.write(encoder.encode('data: [DONE]\n\n'));
      if (!downstreamClosed) await writer.close();
    } catch (error) {
      // In particular, never release after an ambiguous settle timeout: it may already have committed.
      console.error('Managed stream finalization incomplete');
      await writer.abort(error).catch(() => {});
    } finally {
      signal?.removeEventListener('abort', abort);
      writer.releaseLock();
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
    if (url.pathname === '/v1/models' && request.method === 'GET') {
      const balance = await env.AUTH.creditBalance(credentials(request));
      if (balance === 'unauthorized') return json(401, { error: '请先登录' }, cors);
      return json(
        200,
        {
          object: 'list',
          data: MODELS.filter(
            (item) => item.id !== 'chat-vision' || env.ENABLE_CHAT_VISION === 'true',
          ).map(publicModel),
          credit: balance,
        },
        cors,
      );
    }

    if (url.pathname !== '/v1/chat/completions' || request.method !== 'POST') {
      return json(404, { error: '接口不存在' }, cors);
    }
    const isGroup = request.headers.has('X-0xNullAI-Group-Ticket');
    if (!isGroup && !(await withinRateLimit(env, request)))
      return json(429, { error: '请求过于频繁' }, cors);

    let body;
    try {
      body = await readJsonBounded(request);
    } catch {
      return json(400, { error: '请求体格式错误' }, cors);
    }
    if (!body) return json(413, { error: '请求体过大' }, cors);
    if (!Array.isArray(body.messages)) return json(400, { error: 'messages 格式错误' }, cors);
    const requestedModel = typeof body.model === 'string' ? body.model : DEFAULT_MODEL_ID;
    const item = selectedModel(requestedModel);
    if (!item) return json(400, { error: '不支持该平台模型' }, cors);
    if (item.id === 'chat-vision' && env.ENABLE_CHAT_VISION !== 'true')
      return json(403, { error: '聊天视觉模型尚未开放' }, cors);
    const vision = item.imageInput === true;
    let visionRequest;
    if (vision) {
      try {
        visionRequest = prepareVisionRequest(
          body,
          request.headers.get('X-0xNullAI-Usage-Kind'),
          request.headers.get('X-0xNullAI-Conversation-Id'),
          request.headers.get('X-0xNullAI-Run-Id'),
        );
      } catch {
        return json(
          400,
          {
            error:
              item.id === 'vision'
                ? '视频视觉请求需要已归属的对话及单张不超过 250KB 的摄像头画面'
                : '聊天视觉请求需要已归属的私人对话，图片需为不超过 250KB 的单张 JPEG',
          },
          cors,
        );
      }
    } else if (body.messages.some((message) => Array.isArray(message?.content))) {
      return json(400, { error: '平台文字模型不支持图片输入' }, cors);
    }

    const key = request.headers.get('Idempotency-Key');
    if (!key) return json(400, { error: '缺少 Idempotency-Key' }, cors);
    const groupTicket = request.headers.get('X-0xNullAI-Group-Ticket');
    if (vision && groupTicket) return json(400, { error: '群托管模型不支持图片输入' }, cors);
    if (isGroup && (body.stream || body.tools || body.tool_choice || body.api_key || body.apiKey))
      return json(400, { error: '群托管模型仅接受非流式文字请求' }, cors);
    const auth = credentials(request);
    const bodyHash = vision
      ? await requestHash(visionRequest.modelInput)
      : isGroup
        ? await sha256Body(JSON.stringify(body))
        : null;
    if (isGroup) {
      let verified;
      try {
        verified = await env.AUTH.authorizeManagedGroupText(groupTicket, {
          idempotencyKey: key,
          modelId: item.id,
          bodyHash,
        });
      } catch {
        return json(503, { error: '群账务身份暂不可确认' }, cors);
      }
      if (verified === 'unauthorized' || !verified?.payer)
        return json(401, { error: '群账务身份无效' }, cors);
      if (!(await withinRateLimit(env, request, verified.payer)))
        return json(429, { error: '请求过于频繁' }, cors);
    }
    let reservation;
    let reserveTimer;
    try {
      reservation = await Promise.race([
        isGroup
          ? env.AUTH.reserveManagedGroupTextCredits(groupTicket, {
              idempotencyKey: key,
              modelId: item.id,
              credits: estimateReservation(body, item),
              bodyHash,
            })
          : env.AUTH.reserveManagedTextCredits(auth, {
              idempotencyKey: key,
              usageKind:
                request.headers.get('X-0xNullAI-Usage-Kind') === 'video' ? 'video' : 'agent',
              modelId: item.id,
              credits: estimateReservation(body, item),
              ...(vision ? { bodyHash } : {}),
              ...(request.headers.has('X-0xNullAI-Conversation-Id')
                ? {
                    context: {
                      conversationId: request.headers.get('X-0xNullAI-Conversation-Id'),
                      runId: request.headers.get('X-0xNullAI-Run-Id'),
                    },
                  }
                : {}),
            }),
        new Promise((_, reject) => {
          reserveTimer = setTimeout(() => reject(new Error('reserve_timeout')), 3000);
        }),
      ]);
    } catch {
      // The insert may have committed. Do not release or rerun generation without an acknowledgement.
      return json(503, { error: '预留状态尚未确认，请查看账本', billing_status: 'unknown' }, cors);
    } finally {
      clearTimeout(reserveTimer);
    }
    if (reservation === 'unauthorized') return json(401, { error: '请先登录' }, cors);
    if (
      !reservation ||
      typeof reservation.allowed !== 'boolean' ||
      !['pending', 'settled', 'released', 'insufficient', 'rejected'].includes(
        reservation.status,
      ) ||
      (reservation.allowed &&
        (reservation.status !== 'pending' ||
          typeof reservation.capability !== 'string' ||
          !reservation.capability))
    ) {
      return json(503, { error: '预留状态尚未确认，请查看账本', billing_status: 'unknown' }, cors);
    }
    if (!reservation.allowed) {
      const status =
        reservation.status === 'rejected' ? 403 : reservation.status === 'insufficient' ? 402 : 409;
      return json(
        status,
        {
          error:
            status === 403
              ? '会话关联无效或不属于当前账户'
              : status === 402
                ? 'Credit 不足'
                : '该请求已经提交，请勿重复发送',
          credit: reservation,
        },
        cors,
      );
    }

    // A capability refers only to this persisted reservation and survives browser session expiry.
    // Never expose it in responses or persist browser credentials.
    const billingService = env.AUTH;
    let heartbeat;
    const capability = reservation.capability;
    const checkpoint = async (charge, metadata) => {
      let timer;
      try {
        const result = await Promise.race([
          billingService.checkpointManagedText(key, capability, charge, metadata),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('checkpoint_timeout')), 3000);
          }),
        ]);
        if (result?.status !== 'checkpointed') throw new Error('checkpoint_not_acknowledged');
      } finally {
        clearTimeout(timer);
      }
    };
    env = {
      ...env,
      AUTH: {
        checkpoint,
        settleCredits: async (_auth, _key, charge, metadata) => {
          // Non-stream results must be durable before any response is delivered.
          const state = await billingService.inspectManagedText(key, capability);
          if (state?.recovery === 'running') await checkpoint(charge, metadata);
          return billingService.finalizeManagedText(key, capability, 'settle');
        },
        releaseCredits: () => {
          if (heartbeat?.failed) throw new Error('heartbeat_failed_pending_review');
          return billingService.finalizeManagedText(key, capability, 'release');
        },
      },
    };

    if (request.signal.aborted) {
      const billing_status = await releaseAfterFailure(env, auth, key);
      return json(499, { error: '请求已取消', billing_status }, cors);
    }

    heartbeat = billingHeartbeat(billingService, key, capability, request.signal);
    let streamOwnsHeartbeat = false;
    try {
      const workersAiInput = {
        ...(vision ? visionRequest.modelInput : body),
        max_tokens: Math.min(
          Math.max(Math.trunc(Number(body.max_tokens) || 1024), 1),
          MAX_OUTPUT_TOKENS,
        ),
        ...(body.stream ? { stream_options: { include_usage: true } } : {}),
      };
      delete workersAiInput.model;
      delete workersAiInput.api_key;
      delete workersAiInput.apiKey;

      let result;
      try {
        result = await heartbeat.run(env.AI.run(item.upstreamId, workersAiInput));
      } catch (error) {
        if (heartbeat.failed)
          return json(
            503,
            { error: '持久账务连接中断，等待后台核对', billing_status: 'pending' },
            cors,
          );
        console.error('Workers AI request failed', {
          model: item.id,
          upstreamModel: item.upstreamId,
          message: error instanceof Error ? error.message : String(error),
        });
        // A rejected/aborted invocation may have reached the provider. Leave
        // its reservation in the durable outbox for bounded review recovery.
        return json(
          503,
          { error: '平台模型状态未确认，等待账务核对', billing_status: 'pending' },
          cors,
        );
      }

      if (body.stream) {
        const stream = result instanceof Response ? result.body : result;
        if (result instanceof Response && !result.ok) {
          await stream?.cancel().catch(() => {});
          const billing_status = await releaseAfterFailure(env, auth, key);
          return json(502, { error: '上游模型拒绝请求', billing_status }, cors);
        }
        if (!stream || typeof stream.getReader !== 'function') {
          return json(
            502,
            { error: '模型流不可用，等待账务核对', billing_status: 'pending' },
            cors,
          );
        }
        let relay;
        try {
          relay = await relayAndSettle(stream, auth, key, item, env, heartbeat.signal, () =>
            heartbeat.stop(),
          );
        } catch {
          return json(
            502,
            { error: '模型流不可读取，等待账务核对', billing_status: 'pending' },
            cors,
          );
        }
        streamOwnsHeartbeat = true;
        ctx.waitUntil(relay.completion.finally(() => heartbeat.stop()));
        return new Response(relay.readable, {
          status: 200,
          headers: { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' },
        });
      }

      if (result instanceof Response && !result.ok) {
        const billing_status = await releaseAfterFailure(env, auth, key);
        return json(502, { error: '上游模型拒绝请求', billing_status }, cors);
      }
      let payload;
      try {
        payload = result instanceof Response ? await result.json() : result;
        if (!validUsage(payload?.usage)) throw new Error('missing usage');
        if (
          vision &&
          (payload.usage.prompt_tokens > VISION_CONTEXT_TOKENS ||
            payload.usage.completion_tokens > VISION_MAX_OUTPUT_TOKENS ||
            chargedCredits(payload.usage, item) > VISION_MAX_RESERVATION_CREDITS)
        )
          throw new Error('vision usage exceeds quote');
      } catch {
        // A completed upstream response with no usable usage is ambiguous:
        // releasing here could turn real consumption into an unreviewed loss.
        // Stop the heartbeat and let the durable Auth outbox mark it for review.
        return json(
          502,
          { error: '模型响应缺少可信用量，等待账务核对', billing_status: 'pending' },
          cors,
        );
      }
      if (heartbeat.failed)
        return json(
          503,
          { error: '持久账务连接中断，等待后台核对', billing_status: 'pending' },
          cors,
        );
      heartbeat.stop();
      const charged = chargedCredits(payload.usage, item);
      let delivered = payload;
      if (vision) {
        try {
          delivered = normalizeVisionResult(payload);
        } catch {
          // The upstream may have spent tokens, but unusable output is not a
          // successful observation. Keep the hold for durable review.
          return json(
            502,
            { error: '视觉模型结果格式无法使用，等待账务核对', billing_status: 'pending' },
            cors,
          );
        }
      }
      const visionContext = vision
        ? { requestHash: bodyHash, imageBytes: visionRequest.imageBytes }
        : undefined;
      try {
        const final = await finalizeBilling(
          env,
          auth,
          key,
          'settle',
          charged,
          usageMetadata(payload.usage, item, reservation.groupContext, visionContext),
        );
        return json(200, { ...delivered, model: item.id, credit_charged: final.charged }, cors);
      } catch (error) {
        return json(
          503,
          {
            error: '结算未完成或状态尚未确认，请查看账本；请勿重复提交生成',
            billing_status: error.status ?? 'pending',
          },
          cors,
        );
      }
    } finally {
      if (!streamOwnsHeartbeat) heartbeat.stop();
    }
  },
};

export { MODELS, chargedCredits, estimateReservation, selectedModel };
