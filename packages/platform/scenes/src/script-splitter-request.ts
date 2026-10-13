import { authRequestHeaders } from '@0xnullai/auth';
import { MANAGED_DEFAULT_MODEL, MANAGED_SERVICE_URL } from '@0xnullai/llm-providers';
import { SPLIT_MAX_OUTPUT_TOKENS, type ChatMessage, type SplitPrices } from './script-splitter.js';

/**
 * 拆分角色 always uses the managed 猫愿模型, whatever model the user picked for chat: it is a
 * platform feature paid with Credit. The gateway reserves and settles per call, so every
 * request carries a fresh Idempotency-Key and is never retried automatically.
 */

export interface SplitCatalog extends SplitPrices {
  /** Available Credit, when the gateway reports it. */
  available?: number;
}

function billingNote(body: Record<string, unknown>): string {
  return body.billing_status === 'pending' || body.billing_status === 'unknown'
    ? '（扣费结果待核对，可在账本查看）'
    : '';
}

function statusMessage(status: number, body: Record<string, unknown>): string {
  if (status === 401) return '请先登录后使用';
  if (status === 402) return 'Credit 不足，兑换卡密后再试';
  if (status === 413) return '剧本太长，请先精简后再试';
  if (status === 429) return '请求太频繁，请稍后再试';
  const detail = typeof body.error === 'string' && body.error.trim() ? body.error : '';
  if (status >= 500) return `${detail || '猫愿模型暂时不可用，请稍后重试'}${billingNote(body)}`;
  return `${detail || `请求失败（${status}）`}${billingNote(body)}`;
}

async function readBody(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function send(path: string, init: RequestInit): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${MANAGED_SERVICE_URL}${path}`, {
      ...init,
      credentials: 'include',
      cache: 'no-store',
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new Error('网络连接失败，请重试', { cause: error });
  }
  const body = await readBody(response);
  if (!response.ok) throw new Error(statusMessage(response.status, body));
  return body;
}

export async function loadSplitCatalog(signal?: AbortSignal): Promise<SplitCatalog> {
  const body = await send('/v1/models', { method: 'GET', headers: authRequestHeaders(), signal });
  const model = Array.isArray(body.data)
    ? (body.data as Record<string, unknown>[]).find((entry) => entry?.id === MANAGED_DEFAULT_MODEL)
    : undefined;
  const input = model?.inputCreditsPerMillion;
  const output = model?.outputCreditsPerMillion;
  if (
    typeof input !== 'number' ||
    typeof output !== 'number' ||
    !Number.isFinite(input) ||
    !Number.isFinite(output) ||
    input < 0 ||
    output < 0
  )
    throw new Error('猫愿模型价格暂不可用，请稍后重试');
  const available = (body.credit as { available?: unknown } | undefined)?.available;
  return {
    inputCreditsPerMillion: input,
    outputCreditsPerMillion: output,
    ...(typeof available === 'number' && Number.isFinite(available) ? { available } : {}),
  };
}

/** One non-streaming managed completion; returns the assistant text. */
export async function requestSplitCompletion(
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const body = await send('/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      ...authRequestHeaders(),
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
      'X-0xNullAI-Usage-Kind': 'agent',
    },
    body: JSON.stringify({
      model: MANAGED_DEFAULT_MODEL,
      stream: false,
      max_tokens: SPLIT_MAX_OUTPUT_TOKENS,
      messages,
    }),
  });
  const choice = (
    body.choices as { message?: { content?: unknown }; finish_reason?: unknown }[]
  )?.[0];
  const content = choice?.message?.content;
  if (choice?.finish_reason === 'length') throw new Error('这次输出超过了单次上限，请重试');
  if (typeof content !== 'string' || !content.trim())
    throw new Error('猫愿模型没有返回内容，请重试');
  return content;
}
