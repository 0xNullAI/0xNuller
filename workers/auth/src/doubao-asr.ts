/**
 * Doubao streaming speech recognition 2.0, input-streaming mode (`bigmodel_nostream`), used for
 * one saved clip at a time. The protocol is binary frames over a WebSocket: a 4-byte header,
 * then a big-endian payload size and payload. A Worker opens it with `fetch` + `Upgrade` on
 * the https:// URL because only headers can carry the key.
 */
export class AsrProviderError extends Error {
  /** `uncertain`: audio may already have been processed and billed. */
  constructor(readonly uncertain: boolean) {
    super('语音识别暂不可用');
  }
}

const ENDPOINT = 'https://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream';
const CHUNK_BYTES = 16_000;
const TIMEOUT_MS = 45_000;
const MAX_TRANSCRIPT = 4_000;

const MessageType = {
  FullClientRequest: 0b0001,
  AudioOnly: 0b0010,
  FullServerResponse: 0b1001,
  Error: 0b1111,
} as const;
const LAST_PACKET = 0b0010;
const SEQUENCE_PRESENT = 0b0001;

/** Client frame: no compression; JSON for the request, raw bytes for audio. */
export function asrClientFrame(type: number, flags: number, payload: Uint8Array): Uint8Array {
  const json = type === MessageType.FullClientRequest ? 1 : 0;
  const frame = new Uint8Array(8 + payload.length);
  frame.set([0x11, (type << 4) | flags, json << 4, 0]);
  new DataView(frame.buffer).setUint32(4, payload.length);
  frame.set(payload, 8);
  return frame;
}

export interface AsrServerFrame {
  type: number;
  flags: number;
  /** Error frames only. */
  code?: number;
  payload: string;
}

export function parseAsrServerFrame(data: ArrayBuffer | Uint8Array): AsrServerFrame {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < 8 || bytes[0] !== 0x11) throw new Error('bad frame');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = bytes[1]! >> 4;
  const flags = bytes[1]! & 0x0f;
  // Gzip is only used when the client asks for it; this client never does.
  if ((bytes[2]! & 0x0f) !== 0) throw new Error('compressed frame');
  let offset = 4;
  let code: number | undefined;
  if (type === MessageType.Error) {
    code = view.getUint32(offset);
    offset += 4;
  } else if (flags & SEQUENCE_PRESENT) offset += 4;
  if (offset + 4 > bytes.length) throw new Error('bad frame');
  const size = view.getUint32(offset);
  offset += 4;
  if (offset + size > bytes.length) throw new Error('bad frame');
  return {
    type,
    flags,
    ...(code === undefined ? {} : { code }),
    payload: new TextDecoder().decode(bytes.subarray(offset, offset + size)),
  };
}

export interface AsrRequest {
  key: string;
  resourceId: string;
  /** Ogg Opus, see `opus-container.ts`. */
  ogg: Uint8Array;
}

export interface AsrResult {
  text: string;
  /** Duration the provider reports processing; this is what the clip bills by. */
  durationMs: number;
}

export async function recognizeDoubaoClip(
  input: AsrRequest,
  fetcher: typeof fetch = fetch,
): Promise<AsrResult> {
  if (!input.key || !input.resourceId || !input.ogg.length) throw new AsrProviderError(false);
  let socket: WebSocket | null;
  try {
    const response = await fetcher(ENDPOINT, {
      headers: {
        Upgrade: 'websocket',
        'X-Api-Key': input.key,
        'X-Api-Resource-Id': input.resourceId,
        'X-Api-Request-Id': crypto.randomUUID(),
        'X-Api-Connect-Id': crypto.randomUUID(),
      },
      signal: AbortSignal.timeout(15_000),
    });
    socket = response.webSocket;
    if (!socket) await response.body?.cancel().catch(() => undefined);
  } catch {
    // Nothing was sent: the connection itself failed.
    throw new AsrProviderError(false);
  }
  if (!socket) throw new AsrProviderError(false);
  const ws = socket;
  ws.accept();
  return new Promise<AsrResult>((resolve, reject) => {
    let settled = false;
    let sentAudio = false;
    const finish = (outcome: { result: AsrResult } | { error: AsrProviderError }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close(1000);
      } catch {
        /* already closed */
      }
      if ('result' in outcome) resolve(outcome.result);
      else reject(outcome.error);
    };
    const timer = setTimeout(() => finish({ error: new AsrProviderError(true) }), TIMEOUT_MS);
    ws.addEventListener('message', (event) => {
      if (typeof event.data === 'string') return finish({ error: new AsrProviderError(true) });
      let frame: AsrServerFrame;
      try {
        frame = parseAsrServerFrame(event.data);
      } catch {
        return finish({ error: new AsrProviderError(true) });
      }
      if (frame.type === MessageType.Error) {
        // A 4xxxxxxx rejection (bad format, empty audio) produces no recognition to bill.
        const definite = Math.floor((frame.code ?? 0) / 1e7) === 4;
        return finish({ error: new AsrProviderError(!definite) });
      }
      if (frame.type !== MessageType.FullServerResponse) return;
      if ((frame.flags & 0b0011) !== 0b0011) return; // interim result, final one follows
      let body: { audio_info?: { duration?: unknown }; result?: { text?: unknown } };
      try {
        body = JSON.parse(frame.payload);
      } catch {
        return finish({ error: new AsrProviderError(true) });
      }
      const durationMs = body?.audio_info?.duration;
      const text = body?.result?.text;
      if (
        !Number.isSafeInteger(durationMs) ||
        Number(durationMs) <= 0 ||
        typeof text !== 'string' ||
        text.length > MAX_TRANSCRIPT
      )
        return finish({ error: new AsrProviderError(true) });
      finish({ result: { text: text.trim(), durationMs: Number(durationMs) } });
    });
    ws.addEventListener('close', () => finish({ error: new AsrProviderError(sentAudio) }));
    ws.addEventListener('error', () => finish({ error: new AsrProviderError(sentAudio) }));
    try {
      const request = {
        user: { uid: 'maoyuan-asr' },
        audio: { format: 'ogg', codec: 'opus', rate: 16000, bits: 16, channel: 1 },
        request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true },
      };
      ws.send(
        asrClientFrame(
          MessageType.FullClientRequest,
          0,
          new TextEncoder().encode(JSON.stringify(request)),
        ),
      );
      sentAudio = true;
      for (let offset = 0; offset < input.ogg.length; offset += CHUNK_BYTES) {
        const last = offset + CHUNK_BYTES >= input.ogg.length;
        ws.send(
          asrClientFrame(
            MessageType.AudioOnly,
            last ? LAST_PACKET : 0,
            input.ogg.subarray(offset, offset + CHUNK_BYTES),
          ),
        );
      }
    } catch {
      finish({ error: new AsrProviderError(sentAudio) });
    }
  });
}
