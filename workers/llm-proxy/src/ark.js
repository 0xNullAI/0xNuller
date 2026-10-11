/** Volcengine Ark chat completions, the single upstream for managed text and camera frames. */
export const ARK_CHAT_URL = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';

/** Hard output cap for every managed request; the client may only ask for less. */
export const MAX_OUTPUT_TOKENS = 2048;
const DEFAULT_OUTPUT_TOKENS = 1024;
// A stream must deliver its first chunk, and a non-stream call its whole result, within these
// bounds. A primary that misses them is retried once on the fallback model.
export const FIRST_BYTE_TIMEOUT_MS = 30_000;
export const COMPLETION_TIMEOUT_MS = 120_000;

// Only fields the product's clients actually use reach Ark. Everything else (provider keys,
// thinking switches, alternative token limits, n, service tiers) is dropped on purpose.
const FORWARDED_FIELDS = [
  'messages',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'temperature',
  'top_p',
  'response_format',
  'stop',
];

export function outputCap(body) {
  const requested = Math.trunc(
    Number(body?.max_tokens ?? body?.max_completion_tokens) || DEFAULT_OUTPUT_TOKENS,
  );
  return Math.min(Math.max(requested, 1), MAX_OUTPUT_TOKENS);
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Ark's automatic prefix cache routes better with a stable per-conversation key. Only a
 * domain-separated digest leaves the Worker, never the raw conversation, room or account id.
 */
export function promptCacheKey(scope) {
  return scope ? sha256Hex(`0xnullai:prompt-cache:${scope}`) : Promise.resolve(undefined);
}

export function arkRequestBody(input, { model, stream, maxTokens, cacheKey }) {
  const body = { model };
  for (const field of FORWARDED_FIELDS) if (input[field] !== undefined) body[field] = input[field];
  body.max_tokens = maxTokens;
  body.stream = stream === true;
  // Without include_usage a stream carries no token counts and cannot be billed.
  if (body.stream) body.stream_options = { include_usage: true };
  // DeepSeek on Ark reasons by default; the hidden reasoning would consume max_tokens and can
  // leave an empty reply that still costs tokens. Always disable it explicitly.
  body.thinking = { type: 'disabled' };
  if (cacheKey) body.prompt_cache_key = cacheKey;
  return body;
}

function errorCode(text) {
  try {
    const code = JSON.parse(text)?.error?.code;
    return typeof code === 'string' ? code.slice(0, 120) : '';
  } catch {
    return '';
  }
}

/** Ark rejects moderated input with a 400 whose code names the sensitive content. */
export function isContentRejection(result) {
  return result.kind === 'rejected' && /SensitiveContent/i.test(result.code);
}

function retryable(result) {
  return (
    result.kind === 'unavailable' ||
    (result.kind === 'rejected' && (result.status === 429 || result.status >= 500))
  );
}

/** Re-emit the chunk already read so the caller sees the complete upstream stream. */
function primedStream(reader, first) {
  let pending = first;
  return new ReadableStream({
    async pull(controller) {
      if (pending) {
        controller.enqueue(pending);
        pending = null;
        return;
      }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * One upstream attempt. Results:
 * - `result`: non-stream JSON body;
 * - `stream`: a stream whose first chunk has already arrived;
 * - `rejected`: an HTTP error response (no output was produced);
 * - `unavailable`: timeout, network failure or an empty stream; execution state is unknown.
 * A cancelled request rethrows so the caller can keep its existing cancellation handling.
 */
async function attempt(env, payload, signal) {
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('request_cancelled'));
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(
    () => controller.abort(new Error('upstream_timeout')),
    payload.stream ? FIRST_BYTE_TIMEOUT_MS : COMPLETION_TIMEOUT_MS,
  );
  try {
    const response = await fetch(ARK_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.VOLC_ARK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { kind: 'rejected', status: response.status, code: errorCode(text) };
    }
    if (!payload.stream) return { kind: 'result', payload: await response.json() };
    const reader = response.body?.getReader();
    if (!reader) return { kind: 'unavailable', error: new Error('upstream_stream_missing') };
    // An aborted fetch does not always error a body that is already being read.
    const first = await new Promise((resolve, reject) => {
      const stop = () => {
        void reader.cancel().catch(() => {});
        reject(controller.signal.reason);
      };
      if (controller.signal.aborted) return stop();
      controller.signal.addEventListener('abort', stop, { once: true });
      reader.read().then(resolve, reject);
    });
    if (first.done) return { kind: 'unavailable', error: new Error('upstream_stream_empty') };
    return { kind: 'stream', stream: primedStream(reader, first.value) };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { kind: 'unavailable', error };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

/**
 * Call the route's primary model and, only when it is rate limited, failing or silent before
 * any output exists, retry once on the route's fallback model. Both are billed at the route's
 * price, so the fallback never changes what the user pays.
 */
export async function completeWithFallback(env, route, buildPayload, signal) {
  let model = route.model;
  let result = await attempt(env, buildPayload(model), signal);
  if (route.fallbackModel && retryable(result)) {
    console.warn('Managed model primary unavailable; retrying on fallback', {
      status: result.status ?? 'timeout',
      code: result.code || undefined,
    });
    model = route.fallbackModel;
    result = await attempt(env, buildPayload(model), signal);
  }
  return { ...result, model };
}
