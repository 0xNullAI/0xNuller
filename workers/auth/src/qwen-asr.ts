import { boundedResponse } from './bounded-response';

/** Provider-only adapter. Callers must first obtain explicit user consent and a Credit hold. */
export const ASR_MAX_AUDIO_BYTES = 6_000_000;
const MIMES = new Set(['audio/webm', 'audio/ogg']);

export class AsrProviderError extends Error {
  constructor(public readonly uncertain: boolean) {
    super('语音识别暂不可用');
  }
}

function base64(bytes: Uint8Array): string {
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(result);
}

export interface AsrResult {
  text: string;
  seconds: number;
  inputTokens: number;
  outputTokens: number;
}

export async function transcribeQwenAudio(
  key: string,
  bytes: Uint8Array,
  mime: string,
  fetcher: typeof fetch = fetch,
): Promise<AsrResult> {
  if (!key || !MIMES.has(mime) || !bytes.length || bytes.length > ASR_MAX_AUDIO_BYTES)
    throw new Error('语音识别输入无效');
  let response: Response;
  try {
    response = await fetcher('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3-asr-flash',
        stream: false,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'input_audio',
                input_audio: { data: `data:${mime};base64,${base64(bytes)}` },
              },
            ],
          },
        ],
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(45_000),
    });
  } catch {
    throw new AsrProviderError(true);
  }
  if (!response.ok) throw new AsrProviderError(response.status >= 500 || response.status === 429);
  let raw: string;
  try {
    raw = new TextDecoder().decode(await boundedResponse(response, 20_000));
  } catch {
    throw new Error('语音识别结果无效');
  }
  if (raw.length > 20_000) throw new Error('语音识别结果过大');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error('语音识别结果无效');
  }
  if (!body || typeof body !== 'object') throw new Error('语音识别结果无效');
  const value = body as {
    choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown } }>;
    usage?: { seconds?: unknown; prompt_tokens?: unknown; completion_tokens?: unknown };
  };
  const choice = value.choices?.[0];
  const text = typeof choice?.message?.content === 'string' ? choice.message.content.trim() : '';
  const seconds = value.usage?.seconds;
  const inputTokens = value.usage?.prompt_tokens;
  const outputTokens = value.usage?.completion_tokens;
  if (
    choice?.finish_reason !== 'stop' ||
    !text ||
    text.length > 2000 ||
    !Number.isSafeInteger(seconds) ||
    Number(seconds) <= 0 ||
    Number(seconds) > 300 ||
    !Number.isSafeInteger(inputTokens) ||
    Number(inputTokens) < 0 ||
    !Number.isSafeInteger(outputTokens) ||
    Number(outputTokens) < 0
  )
    throw new Error('语音识别结果无效');
  return {
    text,
    seconds: Number(seconds),
    inputTokens: Number(inputTokens),
    outputTokens: Number(outputTokens),
  };
}
