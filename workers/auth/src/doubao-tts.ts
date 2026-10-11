import { boundedResponse } from './bounded-response';

/**
 * Doubao speech synthesis over HTTP chunked transfer (`/api/v3/tts/unidirectional`).
 * The body is a stream of JSON objects: audio chunks `{code:0,data:<base64>}`, optional
 * sentence objects, and a final `{code:20000000,usage:{text_words}}` when the request asks
 * for usage with `X-Control-Require-Usage-Tokens-Return`.
 */
export class TtsProviderError extends Error {
  /** `uncertain`: the provider may already have billed this request. */
  constructor(readonly uncertain: boolean) {
    super('语音合成暂不可用');
  }
}

const ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const DONE = 20_000_000;
export const TTS_MAX_AUDIO_BYTES = 4_000_000;
// Base64 inflates audio by 4/3; the JSON envelope adds a little per chunk.
const MAX_RESPONSE_BYTES = 6_000_000;

export interface TtsRequest {
  key: string;
  resourceId: string;
  voice: string;
  text: string;
  /** Upper bound already accepted by the customer; a larger reported count is not trusted. */
  maxCharacters: number;
}

export interface TtsResult {
  audio: Uint8Array;
  characters: number;
}

function hasMp3Frame(bytes: Uint8Array, offset: number): boolean {
  return (
    bytes.length >= offset + 4 &&
    bytes[offset] === 0xff &&
    (bytes[offset + 1]! & 0xe0) === 0xe0 &&
    (bytes[offset + 1]! & 0x18) !== 0x08 &&
    (bytes[offset + 1]! & 0x06) === 0x02 &&
    (bytes[offset + 2]! & 0xf0) !== 0xf0 &&
    (bytes[offset + 2]! & 0x0c) !== 0x0c
  );
}

/** MP3 may start with ID3 metadata or a frame; a lone header byte can be an error payload. */
export function isMp3Audio(bytes: Uint8Array): boolean {
  if (hasMp3Frame(bytes, 0)) return true;
  if (
    bytes.length < 14 ||
    bytes[0] !== 0x49 ||
    bytes[1] !== 0x44 ||
    bytes[2] !== 0x33 ||
    bytes[3]! < 2 ||
    bytes[3]! > 4 ||
    [6, 7, 8, 9].some((index) => bytes[index]! > 0x7f)
  )
    return false;
  const tagSize = (bytes[6]! << 21) | (bytes[7]! << 14) | (bytes[8]! << 7) | bytes[9]!;
  const footerSize = bytes[3] === 4 && bytes[5]! & 0x10 ? 10 : 0;
  return hasMp3Frame(bytes, 10 + tagSize + footerSize);
}

/** Splits concatenated top-level JSON objects; newlines between them are optional. */
export function splitJsonObjects(raw: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') {
      if (depth++ === 0) start = index;
    } else if (char === '}') {
      if (depth === 0) throw new Error('unbalanced');
      if (--depth === 0) objects.push(raw.slice(start, index + 1));
    } else if (depth === 0 && !/\s/.test(char!)) throw new Error('unexpected');
  }
  if (depth !== 0 || inString) throw new Error('truncated');
  return objects;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function synthesizeDoubaoSpeech(
  input: TtsRequest,
  fetcher: typeof fetch = fetch,
): Promise<TtsResult> {
  if (
    !input.key ||
    !input.resourceId ||
    !input.voice ||
    !input.text.trim() ||
    input.maxCharacters < 1 ||
    input.maxCharacters > 2000
  )
    throw new TtsProviderError(false);
  let response: Response;
  try {
    response = await fetcher(ENDPOINT, {
      method: 'POST',
      headers: {
        'X-Api-Key': input.key,
        'X-Api-Resource-Id': input.resourceId,
        'X-Api-Request-Id': crypto.randomUUID(),
        'X-Control-Require-Usage-Tokens-Return': '*',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        user: { uid: 'maoyuan-tts' },
        req_params: {
          text: input.text,
          speaker: input.voice,
          audio_params: { format: 'mp3', sample_rate: 24000 },
        },
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(45_000),
    });
  } catch {
    throw new TtsProviderError(true);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new TtsProviderError(response.status >= 500 || response.status === 429);
  }
  let objects: Array<Record<string, unknown>>;
  try {
    const raw = new TextDecoder().decode(await boundedResponse(response, MAX_RESPONSE_BYTES));
    objects = splitJsonObjects(raw).map((part) => JSON.parse(part) as Record<string, unknown>);
  } catch {
    throw new TtsProviderError(true);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  let characters: unknown;
  let finished = false;
  for (const object of objects) {
    const code = object.code;
    if (finished) throw new TtsProviderError(true);
    if (code === DONE) {
      finished = true;
      characters = (object.usage as { text_words?: unknown } | undefined)?.text_words;
      continue;
    }
    if (code !== 0) {
      // A 4xxxxxxx code before any audio is a rejected request (bad voice, text too long);
      // anything after audio started, or a server-side code, may already be billed.
      const definite = !chunks.length && typeof code === 'number' && Math.floor(code / 1e7) === 4;
      throw new TtsProviderError(!definite);
    }
    if (typeof object.data !== 'string' || !object.data) continue;
    let chunk: Uint8Array;
    try {
      chunk = decodeBase64(object.data);
    } catch {
      throw new TtsProviderError(true);
    }
    size += chunk.length;
    if (size > TTS_MAX_AUDIO_BYTES) throw new TtsProviderError(true);
    chunks.push(chunk);
  }
  const audio = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    audio.set(chunk, offset);
    offset += chunk.length;
  }
  // Never invent usage: without the provider's own character count the job goes to review.
  if (
    !finished ||
    !Number.isSafeInteger(characters) ||
    Number(characters) <= 0 ||
    Number(characters) > input.maxCharacters ||
    !isMp3Audio(audio)
  )
    throw new TtsProviderError(true);
  return { audio, characters: Number(characters) };
}
