import {
  parsePriceTable,
  tokenCredits,
  type ImageRoute,
  type PriceTable,
  type TokenRoute,
  type TokenUsage,
} from '@0xnullai/ai-pricing';
import { boundedResponse } from './bounded-response';

/**
 * Volcengine Ark, the only managed provider for background text and image generation.
 * Model ids and Credit prices come solely from the `AI_PRICE_TABLE` secret; no endpoint or model
 * may be supplied by a browser.
 */
export interface ArkEnv {
  VOLC_ARK_API_KEY?: string;
  AI_PRICE_TABLE?: string;
}

const API = 'https://ark.cn-beijing.volces.com/api/v3';

export class ArkError extends Error {
  constructor(
    /** True when the provider may have completed (and billed) the request despite the error. */
    public readonly uncertain: boolean,
    message = 'AI服务暂不可用',
  ) {
    super(message);
  }
}

/** Both the key and a valid table are required; either missing disables every Ark feature. */
export function arkConfig(env: ArkEnv): { key: string; table: PriceTable } | null {
  const key = env.VOLC_ARK_API_KEY?.trim();
  const table = parsePriceTable(env.AI_PRICE_TABLE);
  return key && table ? { key, table } : null;
}

export type ArkFeature = 'memory' | 'digest' | 'proactive' | 'image';

/**
 * Usage for every completed provider call, including free features, so provider cost stays visible
 * in Worker logs. Only counts and the table's Credit equivalent are logged, never content.
 */
function logUsage(feature: ArkFeature, model: string, usage: TokenUsage, credits: number) {
  console.info(
    JSON.stringify({
      event: 'ark_usage',
      feature,
      model,
      promptTokens: usage.prompt_tokens ?? 0,
      cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
      credits,
    }),
  );
}

async function post(
  key: string,
  path: string,
  body: unknown,
  timeoutMs: number,
  limit: number,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      // Workers reject redirect 'error'; a 3xx stays !ok and fails below.
      redirect: 'manual',
    });
  } catch {
    // A timeout may have reached the provider after it started work.
    throw new ArkError(true);
  }
  if (!response.ok) throw new ArkError(response.status >= 500);
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(await boundedResponse(response, limit)),
    );
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new ArkError(true);
  }
}

export interface ArkChatRequest {
  feature: Exclude<ArkFeature, 'image'>;
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs?: number;
  /** Upper bound for the raw response body. */
  responseLimit?: number;
}

export interface ArkChatResult {
  content: string;
  model: string;
  usage: TokenUsage;
}

function usageOf(data: Record<string, unknown>): TokenUsage {
  const usage = data.usage;
  return usage && typeof usage === 'object' && !Array.isArray(usage) ? (usage as TokenUsage) : {};
}

async function chatOnce(key: string, route: TokenRoute, model: string, request: ArkChatRequest) {
  const data = await post(
    key,
    '/chat/completions',
    {
      model,
      stream: false,
      max_tokens: request.maxTokens,
      // Ark's DeepSeek and Seed models think by default and may then return empty content.
      thinking: { type: 'disabled' },
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
    },
    request.timeoutMs ?? 45_000,
    request.responseLimit ?? 60_000,
  );
  const usage = usageOf(data);
  // Usage is billed by the provider even when the output is rejected below.
  logUsage(request.feature, model, usage, tokenCredits(route, usage));
  const choice = (
    data.choices as
      | Array<{ finish_reason?: string; message?: { content?: unknown; tool_calls?: unknown[] } }>
      | undefined
  )?.[0];
  if (
    choice?.finish_reason !== 'stop' ||
    choice.message?.tool_calls?.length ||
    typeof choice.message?.content !== 'string'
  )
    throw new ArkError(false, 'AI输出未完成');
  const content = choice.message.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!content || /<\/?think>/.test(content)) throw new ArkError(false, 'AI输出为空');
  return { content, model, usage };
}

/** One bounded, tool-free chat turn. The fallback model is tried only after the primary fails. */
export async function arkChat(
  key: string,
  route: TokenRoute,
  request: ArkChatRequest,
): Promise<ArkChatResult> {
  try {
    return await chatOnce(key, route, route.model, request);
  } catch (error) {
    if (!route.fallbackModel || route.fallbackModel === route.model) throw error;
    return chatOnce(key, route, route.fallbackModel, request);
  }
}

/** Models sometimes wrap a requested JSON object in a Markdown fence. */
export function jsonContent(content: string): string {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(content.trim());
  return fenced ? fenced[1]! : content.trim();
}

/**
 * Seedream text-to-image, optionally guided by one reference image (data URL). Returns base64 so
 * the result never depends on the provider's 24-hour URL.
 */
export async function arkImage(
  key: string,
  route: ImageRoute,
  prompt: string,
  reference: string | null,
): Promise<{ bytes: Uint8Array; mime: string }> {
  const data = await post(
    key,
    '/images/generations',
    {
      model: route.model,
      prompt,
      ...(reference ? { image: reference } : {}),
      size: '2K',
      response_format: 'b64_json',
      output_format: 'jpeg',
      watermark: false,
    },
    120_000,
    20_000_000,
  );
  const usage = data.usage as { generated_images?: unknown } | undefined;
  const generated = Number(usage?.generated_images ?? 0);
  console.info(
    JSON.stringify({ event: 'ark_usage', feature: 'image', model: route.model, generated }),
  );
  const images = data.data;
  const first = Array.isArray(images) ? (images[0] as { b64_json?: unknown } | undefined) : null;
  if (!Array.isArray(images) || images.length !== 1 || typeof first?.b64_json !== 'string')
    throw new ArkError(generated > 0);
  try {
    const binary = atob(first.b64_json);
    if (binary.length > 12_000_000) throw new Error();
    const bytes = Uint8Array.from(binary, (x) => x.charCodeAt(0));
    const mime = bytes[0] === 0x89 ? 'image/png' : bytes[0] === 0xff ? 'image/jpeg' : 'image/webp';
    return { bytes, mime };
  } catch {
    throw new ArkError(true);
  }
}
