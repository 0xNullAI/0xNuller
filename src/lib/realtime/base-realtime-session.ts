/**
 * Shared machinery for every realtime dialect. The OpenAI-family
 * (`OpenAiRealtimeSession`, serving xAI/OpenAI/Azure) and Zhipu
 * (`GlmRealtimeSession`) implementations are ~90% identical — same WS
 * lifecycle, same mic/playback wiring, same event handling, same transcript
 * accumulation — so all of that lives here, and each dialect overrides only
 * the handful of hooks where the wire protocols genuinely differ:
 *
 *   - `buildConnection()`  — URL + auth (subprotocol vs query-param JWT)
 *   - `buildSessionUpdate()` — the `session.update` payload shape
 *   - `encodeAudioFrame()`  — input framing (raw pcm16 vs wav)
 *   - `functionCallId()` / `functionCallOutputItem()` — tool-call id handling
 *   - `handleDialectEvent()` / `onConnected()` / `onClosed()` — dialect-only
 *     events (GLM's heartbeat / built-in web search) and lifecycle
 *
 * Consolidating this is also what stops per-dialect drift bugs: the
 * transcript-accumulation fix and the dual event-name normalization each had
 * to be applied twice when these were two separate files.
 */
import { AudioPlayback, MicCapture, base64ToInt16, float32ToInt16 } from './audio.js';
import type { RealtimeSession, RealtimeSessionOptions } from './realtime-session.js';

export type { RealtimeSessionOptions } from './realtime-session.js';

export const VAD_THRESHOLD = 0.85;
export const VAD_PREFIX_PADDING_MS = 333;
export const VAD_SILENCE_DURATION_MS = 500;

/**
 * The Realtime API exists in the wild under two event-name families — the
 * classic/beta `response.audio.*` and the newer GA `response.output_audio.*`.
 * Which one a provider emits is NOT predictable from which `session.update`
 * shape it accepts (xAI takes the flat shape but its event names vary), so we
 * normalise both to one canonical set and branch on that.
 */
const EVENT_ALIASES: Record<string, string> = {
  'response.output_audio.delta': 'response.audio.delta',
  'response.output_audio_transcript.delta': 'response.audio_transcript.delta',
  'response.output_audio_transcript.done': 'response.audio_transcript.done',
};

function canonicalEventType(type: unknown): string {
  return typeof type === 'string' ? (EVENT_ALIASES[type] ?? type) : '';
}

/** Canonical event types the switch below handles — anything else logs its full payload (temporary, until a live call is confirmed). */
const KNOWN_EVENT_TYPES = new Set([
  'input_audio_buffer.speech_started',
  'response.audio.delta',
  'response.audio.done',
  'response.audio_transcript.delta',
  'response.audio_transcript.done',
  'conversation.item.input_audio_transcription.delta',
  'conversation.item.input_audio_transcription.completed',
  'response.function_call_arguments.done',
  'response.done',
  'error',
]);

export interface RealtimeConnection {
  url: string;
  /** WebSocket subprotocols, when auth rides there (OpenAI family). Omitted when auth is in the URL (GLM). */
  protocols?: string[];
}

export abstract class BaseRealtimeSession implements RealtimeSession {
  protected ws: WebSocket | null = null;
  protected readonly mic = new MicCapture();
  protected readonly playback = new AudioPlayback();
  private readonly assistantTranscripts = new Map<string, string>();
  private userTranscript = '';
  private speaking = false;
  private connected = false;

  constructor(protected readonly options: RealtimeSessionOptions) {}

  isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    // Mic + playback both prepared inside the "开始通话" click's user-activation
    // window: the mic buffers frames until `onFrame` attaches below (xAI's
    // guidance not to wait on the socket), and the output AudioContext must be
    // resumed here or Chrome's autoplay policy leaves it silently suspended.
    await this.mic.start();
    await this.playback.prepare();

    const { url, protocols } = await this.buildConnection();
    const ws = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        this.connected = true;
        this.send(this.buildSessionUpdate());
        this.mic.onFrame((frame) => this.sendAudioFrame(frame));
        this.onConnected();
        this.options.events.onOpen?.();
        resolve();
      };
      ws.onmessage = (event) => {
        if (typeof event.data === 'string') this.handleMessage(event.data);
      };
      ws.onerror = () => {
        const error = new Error('实时语音连接出错');
        this.options.events.onError?.(error);
        if (!this.connected) reject(error);
      };
      ws.onclose = (event) => {
        this.connected = false;
        this.onClosed();
        this.options.events.onClose?.(event.reason || '连接已关闭');
      };
    });
  }

  disconnect(): void {
    this.connected = false;
    this.onClosed();
    this.mic.stop();
    this.playback.close();
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  sendFunctionCallOutput(callId: string, output: string): void {
    this.send({ type: 'conversation.item.create', item: this.functionCallOutputItem(callId, output) });
  }

  requestResponse(): void {
    this.send({ type: 'response.create' });
  }

  whenAudioDrained(): Promise<void> {
    return this.playback.whenDrained();
  }

  updateInstructions(instructions: string): void {
    this.options.instructions = instructions;
    this.send(this.buildSessionUpdate());
  }

  protected send(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  /** Tools declared identically across every supported dialect (flat, not nested under a `function` object). */
  protected mappedTools(): Array<Record<string, unknown>> {
    return this.options.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  private sendAudioFrame(frame: Float32Array): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.send({ type: 'input_audio_buffer.append', audio: this.encodeAudioFrame(float32ToInt16(frame)) });
  }

  private handleMessage(raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    // Dialect-only events (GLM heartbeat / simple_browser) get first refusal.
    if (this.handleDialectEvent(message)) return;

    const type = canonicalEventType(message.type);
    if (!KNOWN_EVENT_TYPES.has(type)) {
      console.log('[dg-voice] unhandled realtime event:', message.type, message);
    } else {
      console.debug('[dg-voice] realtime event:', message.type);
    }

    const itemId = typeof message.item_id === 'string' ? message.item_id : undefined;

    switch (type) {
      case 'input_audio_buffer.speech_started':
        // Barge-in: the user started talking over the assistant — cut audio now.
        this.playback.clear();
        this.setSpeaking(false);
        break;

      case 'response.audio.delta': {
        // Output is raw pcm16 24kHz for every supported dialect (GLM's
        // `output_audio_format: 'pcm'`, OpenAI's pcm) — decode straight to
        // playback.
        const delta = message.delta ?? message.audio;
        if (typeof delta === 'string') {
          this.playback.enqueuePcm16(base64ToInt16(delta));
          this.setSpeaking(true);
        }
        break;
      }

      case 'response.audio_transcript.delta': {
        if (typeof message.delta === 'string') this.emitAssistantDelta(itemId, message.delta);
        break;
      }
      case 'response.audio_transcript.done': {
        this.emitAssistantDone(itemId, typeof message.transcript === 'string' ? message.transcript : undefined);
        break;
      }

      case 'conversation.item.input_audio_transcription.delta': {
        if (typeof message.delta === 'string') {
          this.userTranscript += message.delta;
          this.options.events.onTranscript?.({
            id: itemId ?? 'user-pending',
            role: 'user',
            text: this.userTranscript,
            done: false,
          });
        }
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const transcript = typeof message.transcript === 'string' ? message.transcript : this.userTranscript;
        this.options.events.onTranscript?.({ id: itemId ?? 'user-pending', role: 'user', text: transcript, done: true });
        this.userTranscript = '';
        break;
      }

      case 'response.function_call_arguments.done': {
        const name = message.name;
        const args = message.arguments;
        if (typeof name === 'string' && typeof args === 'string') {
          this.options.events.onFunctionCall?.({ callId: this.functionCallId(message), name, argsJson: args });
        }
        break;
      }

      case 'response.audio.done':
        break;

      case 'response.done':
        this.flushAssistantTranscripts();
        // Audio may still be draining — flip "speaking" off only once it is.
        void this.playback.whenDrained().then(() => this.setSpeaking(false));
        this.options.events.onResponseDone?.();
        break;

      case 'error': {
        // Full payload, not just `.message` — `code`/`param`/`event_id` are
        // what pin down which field of a rejected client event the server
        // didn't like.
        console.error('[dg-voice] realtime error event:', message);
        const error = message.error as { message?: string } | undefined;
        this.options.events.onError?.(new Error(error?.message ?? '服务端返回未知错误'));
        break;
      }

      default:
        break;
    }
  }

  private emitAssistantDelta(itemId: string | undefined, delta: string): void {
    const key = itemId ?? 'assistant-pending';
    const text = (this.assistantTranscripts.get(key) ?? '') + delta;
    this.assistantTranscripts.set(key, text);
    this.options.events.onTranscript?.({ id: key, role: 'assistant', text, done: false });
  }

  private emitAssistantDone(itemId: string | undefined, finalText?: string): void {
    const key = itemId ?? 'assistant-pending';
    const text = finalText ?? this.assistantTranscripts.get(key) ?? '';
    this.assistantTranscripts.delete(key);
    if (text) this.options.events.onTranscript?.({ id: key, role: 'assistant', text, done: true });
  }

  /** A response can end without a per-item `.done` — mark any still-streaming assistant lines complete. */
  private flushAssistantTranscripts(): void {
    for (const [key, text] of [...this.assistantTranscripts]) {
      this.assistantTranscripts.delete(key);
      if (text) this.options.events.onTranscript?.({ id: key, role: 'assistant', text, done: true });
    }
  }

  private setSpeaking(speaking: boolean): void {
    if (this.speaking === speaking) return;
    this.speaking = speaking;
    this.options.events.onSpeakingChange?.(speaking);
  }

  // ---- dialect hooks ----

  protected abstract buildConnection(): Promise<RealtimeConnection>;
  protected abstract buildSessionUpdate(): Record<string, unknown>;
  /** Input frame -> base64 payload for `input_audio_buffer.append`. */
  protected abstract encodeAudioFrame(int16: Int16Array): string;

  /** Which field on the function-call event identifies the call. OpenAI: `call_id`. */
  protected functionCallId(message: Record<string, unknown>): string {
    return typeof message.call_id === 'string' ? message.call_id : 'call';
  }

  /** The `conversation.item.create` item carrying a tool result. OpenAI: includes `call_id`. */
  protected functionCallOutputItem(callId: string, output: string): Record<string, unknown> {
    return { type: 'function_call_output', call_id: callId, output };
  }

  /** Handle a dialect-only event before the shared switch. Return true if consumed. */
  protected handleDialectEvent(_message: Record<string, unknown>): boolean {
    return false;
  }

  protected onConnected(): void {}
  protected onClosed(): void {}
}
