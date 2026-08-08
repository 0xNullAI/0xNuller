/**
 * `openai-realtime` dialect — serves xAI, OpenAI, and Azure OpenAI. All the
 * WS lifecycle / event handling / transcript logic lives in
 * `BaseRealtimeSession`; this class supplies only the three things that
 * differ: the connection (URL + subprotocol auth), the `session.update`
 * shape, and pcm16 input framing.
 *
 * xAI and OpenAI GA have DIVERGED despite xAI's "OpenAI Realtime compatible"
 * claim: xAI takes the classic FLAT `session.update` (verified working live)
 * and rejects the nested one ("Invalid event received"); OpenAI GA (and Azure,
 * which tracks it) moved to the NESTED `session.audio.*` shape. So
 * `buildSessionUpdate()` branches on provider. The base class normalises both
 * event-name families on the receive side, so only this send path differs.
 * The OpenAI/Azure nested path is NOT live-verified.
 */
import {
  BaseRealtimeSession,
  VAD_PREFIX_PADDING_MS,
  VAD_SILENCE_DURATION_MS,
  VAD_THRESHOLD,
  type RealtimeConnection,
  type RealtimeSessionOptions,
} from './base-realtime-session.js';
import { int16ToBase64 } from './audio.js';
import {
  mintAzureRealtimeEphemeralToken,
  mintOpenAiRealtimeEphemeralToken,
  mintXaiRealtimeEphemeralToken,
} from './ephemeral-token.js';
import type { RealtimeProviderId, RealtimeProviderSettings } from './providers.js';
import { apiWsUrl } from '@0xnullai/settings';

const TURN_DETECTION = {
  type: 'server_vad',
  threshold: VAD_THRESHOLD,
  prefix_padding_ms: VAD_PREFIX_PADDING_MS,
  silence_duration_ms: VAD_SILENCE_DURATION_MS,
  // Explicit: if the server defaulted this to false, VAD would commit the
  // buffer but never generate a reply — the "transcribed but no answer"
  // symptom from an early live test.
  create_response: true,
} as const;

function buildWsUrl(providerId: RealtimeProviderId, settings: RealtimeProviderSettings): string {
  switch (providerId) {
    case 'trial': {
      // 统一域下的 Worker 路由（`/api/realtime`）；Worker 固定模型，并在上游那一段
      // 把激活密钥换成真正的 xAI Key。
      //
      // **不要在这里直接用 `location.host` 拼同源地址。** 网页上没问题，但 Tauri 壳的
      // origin 是本地 scheme，那样会连到 `wss://tauri.localhost/api/realtime`。
      return apiWsUrl('/api/realtime');
    }
    case 'xai':
      return `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(settings.model)}`;
    case 'openai':
      return `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(settings.model)}`;
    case 'azure': {
      // GA path /openai/v1/realtime (deployment is pinned by the ephemeral
      // token); the old preview path was
      // /openai/realtime?api-version=2025-04-01-preview&deployment=...
      const host = settings.baseUrl.replace(/^https?:\/\//, '');
      return `wss://${host}/openai/v1/realtime`;
    }
    case 'zhipu':
      throw new Error('智谱 GLM 走 glm-realtime 方言，不应使用 OpenAiRealtimeSession');
  }
}

/**
 * Mints an ephemeral token so the long-lived BYO key never touches the WS
 * handshake; on any minting failure, falls back to the raw key as the
 * subprotocol credential rather than hard-failing the call.
 */
async function resolveCredential(
  providerId: RealtimeProviderId,
  settings: RealtimeProviderSettings,
): Promise<string> {
  try {
    switch (providerId) {
      case 'trial':
        // No real key on the frontend to mint against — the activation key IS
        // the credential; the Worker validates it and mints/uses the real key.
        return settings.apiKey;
      case 'xai':
        return (await mintXaiRealtimeEphemeralToken(settings)).value;
      case 'openai':
        return (await mintOpenAiRealtimeEphemeralToken(settings)).value;
      case 'azure':
        return (await mintAzureRealtimeEphemeralToken(settings)).value;
      case 'zhipu':
        throw new Error('unreachable');
    }
  } catch (error) {
    console.warn(`[dg-voice] ${providerId} 换票失败，回退为直接用 API Key 作为 WebSocket 凭据：`, error);
    return settings.apiKey;
  }
}

export class OpenAiRealtimeSession extends BaseRealtimeSession {
  constructor(
    private readonly providerId: RealtimeProviderId,
    options: RealtimeSessionOptions,
  ) {
    super(options);
  }

  protected async buildConnection(): Promise<RealtimeConnection> {
    const credential = await resolveCredential(this.providerId, this.options.settings);
    return {
      url: buildWsUrl(this.providerId, this.options.settings),
      protocols: ['realtime', `openai-insecure-api-key.${credential}`],
    };
  }

  protected encodeAudioFrame(int16: Int16Array): string {
    return int16ToBase64(int16);
  }

  protected buildSessionUpdate(): Record<string, unknown> {
    if (this.providerId === 'xai' || this.providerId === 'trial') {
      // Classic/flat shape — confirmed working against xAI. Trial is xAI
      // behind the Worker, so it takes the identical payload.
      return {
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: this.options.instructions,
          voice: this.options.settings.voice,
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          input_audio_transcription: { model: 'whisper-1' },
          turn_detection: TURN_DETECTION,
          tools: this.mappedTools(),
          tool_choice: 'auto',
        },
      };
    }

    // OpenAI / Azure GA nested shape (per developers.openai.com/api/docs).
    // NOT live-verified — the `format` object form and `output_modalities`
    // follow the current GA docs but haven't been exercised against a key.
    const pcm = { type: 'audio/pcm', rate: 24000 };
    return {
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: this.options.instructions,
        output_modalities: ['audio'],
        audio: {
          input: { format: pcm, turn_detection: TURN_DETECTION, transcription: { model: 'whisper-1' } },
          output: { format: pcm, voice: this.options.settings.voice, speed: this.options.settings.speed },
        },
        tools: this.mappedTools(),
        tool_choice: 'auto',
      },
    };
  }
}
