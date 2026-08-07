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
 *   - NO `tool_choice`: GLM 400s the whole session.update if it's present
 *     (live-verified). Tools are still declared; GLM just defaults to auto.
 *   - a `heartbeat` server event (~30s) and a `response.function_call.simple_browser`
 *     event (built-in web search) must be tolerated. The heartbeat is server→client
 *     ONLY — do NOT send one back: `{type:'heartbeat'}` is rejected with 400
 *     "API 调用参数有误" (live-verified), which used to kill the session ~30s in.
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

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export class GlmRealtimeSession extends BaseRealtimeSession {
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
        // NO `tool_choice`: GLM-Realtime rejects the whole session.update with
        // 400 "API 调用参数有误" if it's present (verified against a live key —
        // every variant with tool_choice errored, every one without it got
        // session.updated). The OpenAI family accepts it; GLM does not, so it's
        // omitted here rather than in the shared base. GLM defaults to auto.
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
      case 'response.function_call.inner_tool':
      case 'response.function_call.inner_tool.result':
        // GLM wraps a function call in these bracketing events around the real
        // `response.function_call_arguments.done` (which we DO handle). Tolerate
        // them so they don't log as unhandled.
        return true;
      default:
        return false;
    }
  }

  // No client heartbeat: GLM heartbeats server→client (we tolerate it in
  // handleDialectEvent); sending one back is a 400. The WS layer's own
  // ping/pong keeps the socket alive.

  // GLM's server_vad emits speech_started but never speech_stopped, so a
  // server_vad-only turn never completes and the model never replies
  // (live-verified). Drive the turn from the client instead.
  protected override usesClientTurnDetection(): boolean {
    return true;
  }

  /**
   * GLM's generation backend 422s ("Input should be a valid list") on any tool
   * whose object-schema `required` is empty or absent — it coerces the falsy
   * value to null (`[] or None`) and then rejects null. Live-verified: only a
   * NON-EMPTY `required` survives. Our only such tools are shock_stop /
   * vibrate_stop (their single `channel` is optional). So for GLM we mark every
   * property of an otherwise-required-less object as required. Trade-off, GLM
   * only: the model must name a `channel` to stop (it can call twice for both);
   * the 紧急停止 button (emergencyStop) still zeroes everything regardless.
   */
  protected override mappedTools(): Array<Record<string, unknown>> {
    return super.mappedTools().map((tool) => ({
      ...tool,
      parameters: ensureNonEmptyRequired(tool.parameters),
    }));
  }
}

function ensureNonEmptyRequired(parameters: unknown): unknown {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return parameters;
  const schema = parameters as { type?: unknown; properties?: unknown; required?: unknown };
  if (schema.type !== 'object') return parameters;
  if (Array.isArray(schema.required) && schema.required.length > 0) return parameters;
  const propertyNames =
    schema.properties && typeof schema.properties === 'object'
      ? Object.keys(schema.properties as Record<string, unknown>)
      : [];
  if (propertyNames.length === 0) return parameters; // nothing to require; leave as-is
  return { ...schema, required: propertyNames };
}
