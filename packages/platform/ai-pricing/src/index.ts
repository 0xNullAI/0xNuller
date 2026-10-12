/**
 * Managed AI routing and Credit prices.
 *
 * The repository is public, so it carries only the shape of the table and the arithmetic.
 * Each Worker reads the real table from its `AI_PRICE_TABLE` secret at runtime. Every number
 * in it is already a final Credit price; how it was derived lives outside the repository.
 * A missing or malformed table disables the capability instead of charging a default price.
 */

export {
  DEFAULT_MANAGED_VOICE,
  MANAGED_VOICES,
  managedVoiceFor,
  managedVoiceLabel,
  normalizeManagedVoice,
  type ManagedVoice,
} from './voices';

/** Credits per million tokens for one text or vision route. */
export interface TokenRoute {
  /** Upstream model id (Volcengine Ark). */
  model: string;
  /** Used only when the primary model fails; priced the same as the primary. */
  fallbackModel?: string;
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
}

export interface ImageRoute {
  model: string;
  perImage: number;
}

export interface SpeechSynthesisRoute {
  resourceId: string;
  perTenThousandChars: number;
}

export interface SpeechRecognitionRoute {
  resourceId: string;
  perHour: number;
}

/** Realtime voice bills audio and text tokens separately, per direction. */
export interface RealtimeRoute {
  model: string;
  inputAudioPerMillion: number;
  inputTextPerMillion: number;
  outputAudioPerMillion: number;
  outputTextPerMillion: number;
  /** Cache hits are reported on top of the uncached input; without a rate they bill as input. */
  cachedInputAudioPerMillion?: number;
  cachedInputTextPerMillion?: number;
}

export interface PriceTable {
  version: string;
  /** User-facing chat, including the companion's device tools. */
  chat: TokenRoute;
  /** Camera frames in Video. */
  vision: TokenRoute;
  /** Memory extraction, long-conversation digests and scheduled messages. */
  background: TokenRoute;
  image: ImageRoute;
  tts: SpeechSynthesisRoute;
  asr: SpeechRecognitionRoute;
  realtime: RealtimeRoute;
}

export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
}

const MAX_PRICE = 1_000_000_000;

function price(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_PRICE;
}

function id(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:/-]{1,128}$/.test(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function tokenRoute(value: unknown): TokenRoute | null {
  const v = record(value);
  if (
    !v ||
    !id(v.model) ||
    (v.fallbackModel !== undefined && !id(v.fallbackModel)) ||
    !price(v.inputPerMillion) ||
    !price(v.cachedInputPerMillion) ||
    !price(v.outputPerMillion)
  )
    return null;
  return {
    model: v.model,
    ...(v.fallbackModel ? { fallbackModel: v.fallbackModel as string } : {}),
    inputPerMillion: v.inputPerMillion,
    cachedInputPerMillion: v.cachedInputPerMillion,
    outputPerMillion: v.outputPerMillion,
  };
}

/** Parse the `AI_PRICE_TABLE` secret. Returns null for anything incomplete or malformed. */
export function parsePriceTable(raw: unknown): PriceTable | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const v = record(value);
  if (!v || typeof v.version !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(v.version)) return null;
  const chat = tokenRoute(v.chat);
  const vision = tokenRoute(v.vision);
  const background = tokenRoute(v.background);
  const image = record(v.image);
  const tts = record(v.tts);
  const asr = record(v.asr);
  const realtime = record(v.realtime);
  if (
    !chat ||
    !vision ||
    !background ||
    !image ||
    !id(image.model) ||
    !price(image.perImage) ||
    !tts ||
    !id(tts.resourceId) ||
    !price(tts.perTenThousandChars) ||
    !asr ||
    !id(asr.resourceId) ||
    !price(asr.perHour) ||
    !realtime ||
    !id(realtime.model) ||
    !price(realtime.inputAudioPerMillion) ||
    !price(realtime.inputTextPerMillion) ||
    !price(realtime.outputAudioPerMillion) ||
    !price(realtime.outputTextPerMillion) ||
    (realtime.cachedInputAudioPerMillion !== undefined &&
      !price(realtime.cachedInputAudioPerMillion)) ||
    (realtime.cachedInputTextPerMillion !== undefined && !price(realtime.cachedInputTextPerMillion))
  )
    return null;
  return {
    version: v.version,
    chat,
    vision,
    background,
    image: { model: image.model, perImage: image.perImage },
    tts: { resourceId: tts.resourceId, perTenThousandChars: tts.perTenThousandChars },
    asr: { resourceId: asr.resourceId, perHour: asr.perHour },
    realtime: {
      model: realtime.model,
      inputAudioPerMillion: realtime.inputAudioPerMillion,
      inputTextPerMillion: realtime.inputTextPerMillion,
      outputAudioPerMillion: realtime.outputAudioPerMillion,
      outputTextPerMillion: realtime.outputTextPerMillion,
      ...(realtime.cachedInputAudioPerMillion !== undefined
        ? { cachedInputAudioPerMillion: realtime.cachedInputAudioPerMillion as number }
        : {}),
      ...(realtime.cachedInputTextPerMillion !== undefined
        ? { cachedInputTextPerMillion: realtime.cachedInputTextPerMillion as number }
        : {}),
    },
  };
}

function count(value: unknown): number {
  return Math.max(0, Math.trunc(Number(value) || 0));
}

/** Credits for one completed call: always at least 1, rounded up. */
export function tokenCredits(route: TokenRoute, usage: TokenUsage): number {
  const prompt = count(usage.prompt_tokens);
  const cached = Math.min(prompt, count(usage.prompt_tokens_details?.cached_tokens));
  const completion = count(usage.completion_tokens);
  const raw =
    (prompt - cached) * route.inputPerMillion +
    cached * route.cachedInputPerMillion +
    completion * route.outputPerMillion;
  return Math.max(1, Math.ceil(raw / 1_000_000));
}

/** Upper bound reserved before a call starts: every input token uncached, full output. */
export function tokenReservation(
  route: TokenRoute,
  inputTokens: number,
  maxOutputTokens: number,
): number {
  return Math.max(
    1,
    Math.ceil(
      (count(inputTokens) * route.inputPerMillion +
        count(maxOutputTokens) * route.outputPerMillion) /
        1_000_000,
    ),
  );
}

export function imageCredits(route: ImageRoute, images: number): number {
  return Math.max(0, Math.ceil(count(images) * route.perImage));
}

/** Synthesis is billed per character the provider reports. */
export function synthesisCredits(
  route: Pick<SpeechSynthesisRoute, 'perTenThousandChars'>,
  characters: number,
): number {
  return Math.max(1, Math.ceil((count(characters) * route.perTenThousandChars) / 10_000));
}

export function recognitionCredits(route: SpeechRecognitionRoute, durationMs: number): number {
  return Math.max(1, Math.ceil((count(durationMs) * route.perHour) / 3_600_000));
}

export interface RealtimeUsage {
  inputAudioTokens?: number;
  inputTextTokens?: number;
  /** Reported in addition to the uncached input tokens above, not as a subset of them. */
  cachedAudioTokens?: number;
  cachedTextTokens?: number;
  outputAudioTokens?: number;
  outputTextTokens?: number;
}

export function realtimeCredits(route: RealtimeRoute, usage: RealtimeUsage): number {
  const raw =
    count(usage.inputAudioTokens) * route.inputAudioPerMillion +
    count(usage.inputTextTokens) * route.inputTextPerMillion +
    count(usage.cachedAudioTokens) *
      (route.cachedInputAudioPerMillion ?? route.inputAudioPerMillion) +
    count(usage.cachedTextTokens) * (route.cachedInputTextPerMillion ?? route.inputTextPerMillion) +
    count(usage.outputAudioTokens) * route.outputAudioPerMillion +
    count(usage.outputTextTokens) * route.outputTextPerMillion;
  return Math.ceil(raw / 1_000_000);
}

/**
 * Generous usage bound for one minute of a continuous call, used only to size a Credit hold
 * and the call's hard deadline. It is a token estimate, not a price: the prompt is processed
 * again on every spoken round, so text input dominates.
 */
const REALTIME_MINUTE_BOUND: Required<RealtimeUsage> = {
  inputAudioTokens: 600,
  inputTextTokens: 60_000,
  cachedAudioTokens: 0,
  cachedTextTokens: 0,
  outputAudioTokens: 2_400,
  outputTextTokens: 1_200,
};

/** Credits held for up to `minutes` of a realtime call; at least 1. */
export function realtimeReservation(route: RealtimeRoute, minutes: number): number {
  const scale = Math.max(0, Number(minutes) || 0);
  const bound = Object.fromEntries(
    Object.entries(REALTIME_MINUTE_BOUND).map(([key, value]) => [key, value * scale]),
  ) as RealtimeUsage;
  return Math.max(1, realtimeCredits(route, bound));
}
