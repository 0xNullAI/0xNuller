import { boundedResponse } from './bounded-response';

/** Non-streaming CosyVoice response contract: https://help.aliyun.com/en/model-studio/cosyvoice-tts-http-api */
export class TtsProviderError extends Error {
  constructor(readonly uncertain: boolean) {
    super('语音合成暂不可用');
  }
}

const RESULT_HOST = 'dashscope-result-bj.oss-cn-beijing.aliyuncs.com';

export interface TtsProviderResult {
  url: string;
  expiresAt: number;
  characters: number;
}

export function trustedAudioUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    // Alibaba's example uses http; only the HTTPS version is ever fetched by us.
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.hostname !== RESULT_HOST ||
      url.username ||
      url.password ||
      url.port ||
      !url.pathname.endsWith('.mp3') ||
      !url.search
    )
      return null;
    url.protocol = 'https:';
    return url.toString();
  } catch {
    return null;
  }
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

export async function synthesizeCosyvoice(
  key: string,
  workspaceId: string,
  text: string,
  maxCharacters: number,
  fetcher: typeof fetch = fetch,
): Promise<TtsProviderResult> {
  if (
    !key ||
    !/^[A-Za-z0-9-]{4,80}$/.test(workspaceId) ||
    !text.trim() ||
    maxCharacters < 1 ||
    maxCharacters > 1000
  )
    throw new TtsProviderError(false);
  let response: Response;
  try {
    response = await fetcher(
      `https://${workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'cosyvoice-v3-flash',
          input: { text, voice: 'longanyang', format: 'mp3' },
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(45_000),
      },
    );
  } catch {
    throw new TtsProviderError(true);
  }
  if (!response.ok) throw new TtsProviderError(response.status >= 500 || response.status === 429);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(await boundedResponse(response, 16_000)));
  } catch {
    throw new TtsProviderError(true);
  }
  const value = body as {
    output?: { finish_reason?: unknown; audio?: { url?: unknown; expires_at?: unknown } };
    usage?: { characters?: unknown };
  };
  const rawUrl = value?.output?.audio?.url;
  const url = typeof rawUrl === 'string' ? trustedAudioUrl(rawUrl) : null;
  const expiresAt = Number(value?.output?.audio?.expires_at) * 1000;
  const characters = value?.usage?.characters;
  if (
    value?.output?.finish_reason !== 'stop' ||
    !url ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Date.now() + 60_000 ||
    !Number.isSafeInteger(characters) ||
    Number(characters) <= 0 ||
    Number(characters) > maxCharacters
  )
    throw new TtsProviderError(true);
  return { url, expiresAt, characters: Number(characters) };
}

/** Never follow a provider-controlled redirect or stream an unbounded response to a client. */
export async function fetchTrustedAudio(
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<Uint8Array> {
  if (trustedAudioUrl(url) !== url) throw new TtsProviderError(false);
  const response = await fetcher(url, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new TtsProviderError(true);
  const bytes = await boundedResponse(response, 4_000_000);
  // MP3 may start with ID3 metadata or a frame. Require a real Layer III frame
  // after the tag; a lone 'I', 0xff or ID3 header can be an error payload.
  if (!isMp3Audio(bytes)) throw new TtsProviderError(true);
  return bytes;
}
