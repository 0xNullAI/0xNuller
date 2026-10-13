import { CONTENT_FILTER_REPLY } from './content-filter.js';
import { tokenCredits, tokenReservation } from '@0xnullai/ai-pricing';
import {
  completeWithFallback,
  arkRequestBody,
  isContentRejection,
  outputCap,
  promptCacheKey,
} from './ark.js';
import { billingHeartbeat } from './billing-heartbeat.js';
import { finalizeBilling, validUsage } from './billing.js';
import {
  DEFAULT_MODEL_ID,
  VISION_MAX_INPUT_TOKENS,
  VISION_MODEL_IDS,
  estimateInputTokens,
  isManagedModel,
  managedConfig,
  publicCatalog,
} from './routing.js';
import { normalizeVisionResult, prepareVisionRequest, requestHash } from './vision.js';
import { withServerErrorCounting } from '@0xnullai/observability';

/**
 * Managed 猫愿 model service on Volcengine Ark. Every successful request consumes Credit.
 *
 * @typedef {object} Env
 * @property {string} ALLOWED_ORIGINS Comma-separated browser origins.
 * @property {string} [ENABLE_CHAT_VISION] "true" opens the private chat image protocol.
 * @property {string} [AI_PRICE_TABLE] Secret: JSON price table read by `@0xnullai/ai-pricing`.
 * @property {string} [VOLC_ARK_API_KEY] Secret: Ark API key.
 * @property {object} AUTH Service binding to Auth's `AuthOwnershipService`.
 * @property {{ limit(input: { key: string }): Promise<{ success: boolean }> }} RATE_LIMITER
 */

const MAX_BODY_BYTES = 1024 * 1024;
/** A group AI offers a handful of device tools; anything larger is not one the RoomDO built. */
const MAX_GROUP_TOOLS = 8;
/** Shown instead of a moderated reply; the conversation continues normally. */

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

async function releaseAfterFailure(env, auth, key) {
  try {
    await finalizeBilling(env, auth, key, 'release');
    return 'released';
  } catch (error) {
    console.error('Managed billing release not acknowledged');
    return error.status ?? 'pending';
  }
}

function usageMetadata(usage, settlement, outcome) {
  return {
    model: settlement.modelId,
    upstreamModel: settlement.upstreamModel,
    usage,
    priceVersion: settlement.priceVersion,
    ...(outcome.finishReason ? { finishReason: outcome.finishReason } : {}),
    ...(outcome.finishReason === 'length' ? { truncated: true } : {}),
    ...(outcome.contentFiltered ? { contentFiltered: true } : {}),
    ...(settlement.groupContext ? { groupContext: settlement.groupContext } : {}),
    ...(settlement.visionContext ?? {}),
  };
}

function hasOutput(message) {
  return Boolean(
    message &&
    ((typeof message.content === 'string' && message.content.trim()) ||
      (Array.isArray(message.tool_calls) && message.tool_calls.length > 0)),
  );
}

/** A moderated completion is delivered as a neutral reply; its real usage is still billed. */
function withFilteredReply(payload) {
  const [first, ...rest] = payload.choices;
  return {
    ...payload,
    choices: [
      {
        ...first,
        finish_reason: 'stop',
        message: { role: 'assistant', content: CONTENT_FILTER_REPLY },
      },
      ...rest,
    ],
  };
}

/** Ark refused the input itself: nothing ran, the hold was released, nothing is charged. */
function rejectedInputReply(stream, modelId, cors) {
  const id = `filtered-${crypto.randomUUID()}`;
  if (stream) {
    const chunk = {
      id,
      object: 'chat.completion.chunk',
      model: modelId,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: CONTENT_FILTER_REPLY },
          finish_reason: 'stop',
        },
      ],
    };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      status: 200,
      headers: { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' },
    });
  }
  return json(
    200,
    {
      id,
      object: 'chat.completion',
      model: modelId,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: CONTENT_FILTER_REPLY },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      credit_charged: 0,
      content_filtered: true,
    },
    cors,
  );
}

/** Hide the upstream model, note finish reasons and swap a moderated ending for a neutral one. */
function rewriteStreamEvent(event, outcome, modelId) {
  if (!event || typeof event !== 'object') return;
  if ('model' in event) event.model = modelId;
  for (const choice of Array.isArray(event.choices) ? event.choices : []) {
    if (!choice || typeof choice !== 'object') continue;
    const delta = choice.delta;
    if (
      delta &&
      ((typeof delta.content === 'string' && delta.content) ||
        (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0))
    ) {
      outcome.output = true;
      // Byte count over-estimates tokens, so an estimated charge never undercounts output.
      outcome.outputBytes += new TextEncoder().encode(JSON.stringify(delta)).byteLength;
    }
    if (typeof choice.finish_reason === 'string') outcome.finishReason = choice.finish_reason;
    if (choice.finish_reason === 'content_filter') {
      outcome.contentFiltered = true;
      choice.delta = { content: (outcome.output ? '\n' : '') + CONTENT_FILTER_REPLY };
      choice.finish_reason = 'stop';
      outcome.output = true;
    }
  }
}

/**
 * After the browser leaves, keep reading upstream (without forwarding) for at most this long so
 * its usage frame can still be billed. It stays inside the runtime's post-disconnect waitUntil
 * allowance; past it the upstream is cancelled and an estimated charge is settled instead.
 */
const DISCONNECTED_DRAIN_MS = 20_000;
const MISSING_USAGE = 'upstream stream did not report valid usage';

/**
 * Usage for a reply whose browser left before the upstream reported real usage. The input side
 * is the reservation's own conservative estimate; output counts the bytes actually received, or
 * the whole output cap when the upstream was cut off while it may still have been generating.
 */
function estimatedUsage({ inputTokens, maxTokens }, outcome, finished) {
  return {
    prompt_tokens: inputTokens,
    completion_tokens: finished ? Math.min(maxTokens, outcome.outputBytes) : maxTokens,
  };
}

async function relayAndSettle(
  upstreamBody,
  { auth, key, route, settlement, credits, inputTokens, maxTokens },
  env,
  { signal, clientSignal },
  finishHeartbeat,
) {
  const reader = upstreamBody.getReader();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let usage = null;
  let terminal = false;
  const outcome = { output: false, outputBytes: 0, finishReason: null, contentFiltered: false };
  let downstreamClosed = false;
  let drainTimer;
  let drainExpired = false;
  let completed = false;
  // A browser that leaves only stops forwarding. The inference upstream keeps running and is
  // paid for, so keep reading (bounded) until its usage arrives, then settle that.
  const disconnect = () => {
    if (downstreamClosed || completed) return;
    downstreamClosed = true;
    void writer.abort(new Error('request_cancelled')).catch(() => {});
    if (usage) {
      void reader.cancel().catch(() => {});
      return;
    }
    drainTimer = setTimeout(() => {
      drainExpired = true;
      void reader.cancel().catch(() => {});
    }, DISCONNECTED_DRAIN_MS);
  };
  // A failed write is the browser leaving, not an upstream failure.
  const forward = async (bytes) => {
    if (!downstreamClosed) await writer.write(bytes).catch(disconnect);
  };
  void writer.closed.catch(disconnect);
  clientSignal?.addEventListener('abort', disconnect, { once: true });
  if (clientSignal?.aborted) disconnect();
  // A lost billing lease is different: Auth no longer accepts usage, so stop at once.
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
    let delivered = frame;
    if (data) {
      try {
        const event = JSON.parse(data);
        if (validUsage(event?.usage)) usage = event.usage;
        rewriteStreamEvent(event, outcome, settlement.modelId);
        delivered = `data: ${JSON.stringify(event)}`;
      } catch {
        /* Non-JSON SSE remains pass-through. */
      }
    }
    if (usage)
      await env.AUTH.checkpoint(
        tokenCredits(route, usage),
        usageMetadata(usage, settlement, outcome),
      );
    // Account usage before the write, which may reject when the browser disconnects.
    return encoder.encode(delivered + '\n\n');
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
            if (encoded) await forward(encoded);
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
        // Once nobody is listening, the recorded usage is all that is left to read for.
        const finished = terminal || (downstreamClosed && usage);
        if (finished) void reader.cancel().catch(() => {});
        for (const frame of frames) {
          await forward(frame);
        }
        if (finished) break;
      }
      if (!usage) throw new Error(MISSING_USAGE);
    } catch (error) {
      transportError = error;
      void reader.cancel().catch(() => {});
    } finally {
      completed = true;
      clearTimeout(drainTimer);
      clientSignal?.removeEventListener('abort', disconnect);
      reader.releaseLock();
    }
    let charge = usage ? tokenCredits(route, usage) : null;
    let metadata = usage ? usageMetadata(usage, settlement, outcome) : null;
    if (!usage && downstreamClosed && !signal?.aborted) {
      // The browser left and no usage arrived in the drain window. The reply had started, so
      // the inference was paid for: bill a conservative estimate rather than letting recovery
      // release the hold. A lost lease (signal) is skipped because Auth refuses it anyway.
      const estimate = estimatedUsage(
        { inputTokens, maxTokens },
        outcome,
        !drainExpired && transportError?.message === MISSING_USAGE,
      );
      const estimatedCharge = Math.min(credits, tokenCredits(route, estimate));
      const estimatedMetadata = {
        ...usageMetadata(estimate, settlement, outcome),
        estimated: true,
      };
      try {
        await env.AUTH.checkpoint(estimatedCharge, estimatedMetadata);
        [usage, charge, metadata] = [estimate, estimatedCharge, estimatedMetadata];
      } catch {
        console.error('Managed estimated usage not acknowledged');
      }
    }
    finishHeartbeat();
    try {
      if (!usage) {
        // The upstream may already have performed paid inference. Without
        // trusted usage, leave the durable hold for Auth's review recovery.
        await writer.abort(transportError ?? new Error('missing_valid_usage')).catch(() => {});
        return;
      }
      await finalizeBilling(env, auth, key, 'settle', charge, metadata);
      if (transportError) {
        await writer.abort(transportError).catch(() => {});
        return;
      }
      if (outcome.finishReason === 'length') {
        console.warn('Managed reply reached the output cap', { model: settlement.modelId });
        // A cut-off reply with nothing in it is not a success, even though its tokens are billed.
        if (!outcome.output) {
          await writer.abort(new Error('truncated_empty_reply')).catch(() => {});
          return;
        }
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

const MANAGED_OFF = '平台模型暂未开放';

const llmProxyWorker = {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin, env);
    if (origin && !allowedOrigins(env).has(origin)) return json(403, { error: '来源不被允许' });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (url.pathname === '/v1/models' && request.method === 'GET') {
      // Without a price table or upstream key there is nothing honest to quote.
      const config = managedConfig(env);
      if (!config) return json(503, { error: MANAGED_OFF }, cors);
      const balance = await env.AUTH.creditBalance(credentials(request));
      if (balance === 'unauthorized') return json(401, { error: '请先登录' }, cors);
      return json(
        200,
        { object: 'list', data: publicCatalog(config.table, env), credit: balance },
        cors,
      );
    }

    if (url.pathname !== '/v1/chat/completions' || request.method !== 'POST') {
      return json(404, { error: '接口不存在' }, cors);
    }
    // Fail closed before any hold: never charge a default price or call without a key.
    const config = managedConfig(env);
    if (!config) return json(503, { error: MANAGED_OFF }, cors);
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
    const modelId = typeof body.model === 'string' ? body.model : DEFAULT_MODEL_ID;
    if (!isManagedModel(modelId)) return json(400, { error: '不支持该平台模型' }, cors);
    if (modelId === 'chat-vision' && env.ENABLE_CHAT_VISION !== 'true')
      return json(403, { error: '聊天视觉模型尚未开放' }, cors);
    const vision = VISION_MODEL_IDS.includes(modelId);
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
              modelId === 'vision'
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
    // The signed body hash proves the tools came from the Chat RoomDO, never from a browser.
    if (
      isGroup &&
      (body.stream ||
        body.api_key ||
        body.apiKey ||
        (body.tools !== undefined &&
          (!Array.isArray(body.tools) || body.tools.length > MAX_GROUP_TOOLS)))
    )
      return json(400, { error: '群托管模型仅接受非流式文字请求' }, cors);

    const { table } = config;
    const modelInput = vision ? visionRequest.modelInput : body;
    const maxTokens = vision ? visionRequest.modelInput.max_tokens : outputCap(body);
    const route = vision && visionRequest.imageBytes > 0 ? table.vision : table.chat;
    const inputTokens = estimateInputTokens(modelInput);
    if (vision && inputTokens > VISION_MAX_INPUT_TOKENS)
      return json(413, { error: '视觉请求内容过长' }, cors);
    const credits = tokenReservation(route, inputTokens, maxTokens);
    const auth = credentials(request);
    const bodyHash = vision
      ? await requestHash(modelInput)
      : isGroup
        ? await requestHash(body)
        : null;
    if (isGroup) {
      let verified;
      try {
        verified = await env.AUTH.authorizeManagedGroupText(groupTicket, {
          idempotencyKey: key,
          modelId,
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
    const conversationId = request.headers.get('X-0xNullAI-Conversation-Id');
    let reservation;
    let reserveTimer;
    try {
      reservation = await Promise.race([
        isGroup
          ? env.AUTH.reserveManagedGroupTextCredits(groupTicket, {
              idempotencyKey: key,
              modelId,
              credits,
              bodyHash,
            })
          : env.AUTH.reserveManagedTextCredits(auth, {
              idempotencyKey: key,
              usageKind:
                request.headers.get('X-0xNullAI-Usage-Kind') === 'video' ? 'video' : 'agent',
              modelId,
              credits,
              ...(vision ? { bodyHash } : {}),
              ...(conversationId !== null
                ? {
                    context: {
                      conversationId,
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

    const stream = Boolean(body.stream) && !vision;
    const group = reservation.groupContext;
    // Only an Auth-verified scope keys the cache: the signed group room or an owned conversation.
    const cacheKey = await promptCacheKey(
      group
        ? `group:${group.room}:${group.roleId}`
        : conversationId
          ? `conversation:${conversationId}`
          : null,
    );
    const settlement = {
      modelId,
      upstreamModel: route.model,
      priceVersion: table.version,
      groupContext: group,
      visionContext: vision
        ? { requestHash: bodyHash, imageBytes: visionRequest.imageBytes }
        : undefined,
    };

    heartbeat = billingHeartbeat(billingService, key, capability);
    let streamOwnsHeartbeat = false;
    // Once the provider is called it runs (and is paid for) whether or not the browser stays.
    // Keep this handler alive past a disconnect so the result still reaches settlement.
    let finishGeneration;
    ctx.waitUntil(new Promise((resolve) => (finishGeneration = resolve)));
    try {
      let result;
      try {
        result = await heartbeat.run(
          completeWithFallback(
            env,
            route,
            (model) => arkRequestBody(modelInput, { model, stream, maxTokens, cacheKey }),
            heartbeat.signal,
          ),
        );
      } catch {
        // Heartbeat lost mid-call: the provider may have run, so keep the hold.
        return json(
          503,
          heartbeat.failed
            ? { error: '持久账务连接中断，等待后台核对', billing_status: 'pending' }
            : { error: '平台模型状态未确认，等待账务核对', billing_status: 'pending' },
          cors,
        );
      }
      settlement.upstreamModel = result.model;

      if (result.kind === 'unavailable') {
        console.error('Managed model request failed', {
          model: modelId,
          upstreamModel: result.model,
          message: result.error instanceof Error ? result.error.message : String(result.error),
        });
        // A timed-out or dropped call may have reached the provider. Leave its reservation in
        // the durable outbox for bounded review recovery.
        return json(
          503,
          { error: '平台模型状态未确认，等待账务核对', billing_status: 'pending' },
          cors,
        );
      }
      if (result.kind === 'rejected') {
        const billing_status = await releaseAfterFailure(env, auth, key);
        if (isContentRejection(result) && billing_status === 'released')
          return rejectedInputReply(stream, modelId, cors);
        return json(502, { error: '上游模型拒绝请求', billing_status }, cors);
      }

      if (stream) {
        const relay = await relayAndSettle(
          result.stream,
          { auth, key, route, settlement, credits, inputTokens, maxTokens },
          env,
          { signal: heartbeat.signal, clientSignal: request.signal },
          () => heartbeat.stop(),
        );
        streamOwnsHeartbeat = true;
        ctx.waitUntil(relay.completion.finally(() => heartbeat.stop()));
        return new Response(relay.readable, {
          status: 200,
          headers: { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' },
        });
      }

      let payload = result.payload;
      let charged;
      try {
        if (!validUsage(payload?.usage)) throw new Error('missing usage');
        charged = tokenCredits(route, payload.usage);
        // Auth refuses a charge above the hold; surface it for review instead of retrying.
        if (charged > credits) throw new Error('usage exceeds reservation');
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
      const outcome = {
        finishReason: payload.choices?.[0]?.finish_reason ?? null,
        contentFiltered: false,
      };
      if (outcome.finishReason === 'content_filter') {
        payload = withFilteredReply(payload);
        outcome.contentFiltered = true;
      }
      const emptyTruncated =
        outcome.finishReason === 'length' && !hasOutput(payload.choices?.[0]?.message);
      if (vision && !emptyTruncated) {
        try {
          payload = normalizeVisionResult(payload);
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
      if (outcome.finishReason === 'length')
        console.warn('Managed reply reached the output cap', { model: modelId });
      let final;
      try {
        final = await finalizeBilling(
          env,
          auth,
          key,
          'settle',
          charged,
          usageMetadata(payload.usage, settlement, outcome),
        );
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
      // The tokens were really spent, but an empty cut-off reply is never reported as success.
      if (emptyTruncated)
        return json(
          502,
          {
            error: '模型回复超出长度上限且没有内容',
            billing_status: 'settled',
            credit_charged: final.charged,
          },
          cors,
        );
      return json(
        200,
        {
          ...payload,
          model: modelId,
          credit_charged: final.charged,
          ...(outcome.finishReason === 'length' ? { truncated: true } : {}),
          ...(outcome.contentFiltered ? { content_filtered: true } : {}),
        },
        cors,
      );
    } finally {
      finishGeneration();
      if (!streamOwnsHeartbeat) heartbeat.stop();
    }
  },
};

export default withServerErrorCounting(llmProxyWorker, {
  worker: 'llm-proxy',
  sink: (env) => env.AUTH,
});
