/**
 * `glm-realtime` dialect — Zhipu GLM-Realtime. Verified against
 * docs.bigmodel.cn/cn/guide/models/sound-and-video/glm-realtime. Shares all
 * lifecycle/event handling with `BaseRealtimeSession`; overrides only where
 * GLM differs from the OpenAI family:
 *
 *   - auth: a locally-signed HS256 JWT in a `?Authorization=` query param
 *     (browsers can't set the header GLM's docs describe; a live probe
 *     confirmed the server also reads the query param). No network round trip.
 *   - input audio: wav-framed (`wrapPcm16AsWav`); output is raw pcm 24kHz.
 *   - `chat_mode`/`tts_source` live inside `beta_fields`, not at the top level.
 *   - a `heartbeat` server event (~30s) and a `response.function_call.simple_browser`
 *     event (built-in web search) must be tolerated.
 *   - the function-call event carries `name`/`arguments`/`response_id` with NO
 *     `call_id`, and `function_call_output` takes no `call_id`.
 */
import {
  BaseRealtimeSession,
  type RealtimeConnection,
  type RealtimeSessionOptions,
} from './base-realtime-session.js';
import { wrapPcm16AsWav } from './audio.js';
import { signZhipuJwt } from './zhipu-jwt.js';

const GLM_REALTIME_WS_URL = 'wss://open.bigmodel.cn/api/paas/v4/realtime';
const HEARTBEAT_INTERVAL_MS = 30_000;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export class GlmRealtimeSession extends BaseRealtimeSession {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: RealtimeSessionOptions) {
    super(options);
  }

  protected async buildConnection(): Promise<RealtimeConnection> {
    const jwt = await signZhipuJwt(this.options.settings.apiKey);
    return { url: `${GLM_REALTIME_WS_URL}?Authorization=${encodeURIComponent(jwt)}` };
  }

  protected encodeAudioFrame(int16: Int16Array): string {
    // GLM input is wav (self-describes its 24kHz rate in the header).
    return toBase64(new Uint8Array(wrapPcm16AsWav(int16)));
  }

  protected buildSessionUpdate(): Record<string, unknown> {
    return {
      type: 'session.update',
      session: {
        model: this.options.settings.model,
        instructions: this.options.instructions,
        voice: this.options.settings.voice,
        input_audio_format: 'wav',
        output_audio_format: 'pcm', // pcm-only per docs; NOT wav (was corrupting output)
        turn_detection: { type: 'server_vad', create_response: true },
        tools: this.mappedTools(),
        tool_choice: 'auto',
        beta_fields: { chat_mode: 'audio', tts_source: 'e2e' },
      },
    };
  }

  protected functionCallId(message: Record<string, unknown>): string {
    // GLM's event has no `call_id` — fall back to `response_id`, then a synth
    // id, so requiring call_id doesn't silently drop the call.
    if (typeof message.call_id === 'string') return message.call_id;
    if (typeof message.response_id === 'string') return message.response_id;
    return `glm-call-${typeof message.name === 'string' ? message.name : 'x'}`;
  }

  protected functionCallOutputItem(_callId: string, output: string): Record<string, unknown> {
    // GLM's documented function_call_output is just `{type, output}` — the
    // server associates it with the pending call by response context.
    return { type: 'function_call_output', output };
  }

  protected handleDialectEvent(message: Record<string, unknown>): boolean {
    switch (message.type) {
      case 'heartbeat':
        return true; // server keepalive — ignore
      case 'response.function_call.simple_browser':
        return true; // GLM's built-in web search — DG-Voice doesn't expose browsing
      default:
        return false;
    }
  }

  protected onConnected(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.send({ type: 'heartbeat' }), HEARTBEAT_INTERVAL_MS);
  }

  protected onClosed(): void {
    this.stopHeartbeat();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
