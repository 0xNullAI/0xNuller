/**
 * Realtime session machinery: WS lifecycle, mic/playback wiring, event
 * handling, transcript accumulation, and the fail-closed playback gate for
 * device-capable replies. A subclass supplies only the wire-specific hooks:
 *
 *   - `buildConnection()`   — URL + auth
 *   - `buildSessionUpdate()` — the `session.update` payload shape
 *   - `encodeAudioFrame()`   — input framing
 */
import { AudioPlayback, MicCapture, base64ToInt16, float32ToInt16 } from './audio.js';
import { applyWebSocketProxy } from '@0xnullai/settings';
import type { RealtimeSession, RealtimeSessionOptions } from './realtime-session.js';
import type { ToolDefinition } from '@dg-kit/core';
import { isDeviceToolName } from '@dg-agent/core';

export type { RealtimeSessionOptions } from './realtime-session.js';

/**
 * How long to wait for the WebSocket handshake before giving up. Without this a
 * hung connection (no open/error/close ever fires — common when a flaky network
 * silently blackholes the socket, e.g. mainland China reaching an overseas
 * endpoint) leaves the caller awaiting forever, so the UI stays stuck on
 * "连接中" with no error and no way out.
 */
export const CONNECT_TIMEOUT_MS = 15000;

// Transcript ids are namespaced by role so an upstream that reuses one item_id
// for the user's transcription and the assistant's reply cannot let the reply
// overwrite the user's line.
const userTranscriptId = (itemId: string | undefined, turn: number): string =>
  `user:${itemId ?? `pending-${turn}`}`;
const assistantTranscriptId = (key: string): string => `assistant:${key}`;

/**
 * Realtime event names exist under two families — the classic `response.audio.*` and the
 * newer `response.output_audio.*`. The Worker translates the provider's events into this
 * protocol and uses the newer names; both are normalised to one canonical set here.
 */
const EVENT_ALIASES: Record<string, string> = {
  'response.output_audio.delta': 'response.audio.delta',
  'response.output_audio_transcript.delta': 'response.audio_transcript.delta',
  'response.output_audio_transcript.done': 'response.audio_transcript.done',
  'response.output_audio.done': 'response.audio.done',
  // GA renamed the item event; it still carries the item in `item`.
  'conversation.item.added': 'conversation.item.created',
};

function canonicalEventType(type: unknown): string {
  return typeof type === 'string' ? (EVENT_ALIASES[type] ?? type) : '';
}

/** Canonical event types the switch below handles — anything else logs its full payload (temporary, until a live call is confirmed). */
const KNOWN_EVENT_TYPES = new Set([
  'input_audio_buffer.speech_started',
  'response.created',
  'response.audio.delta',
  'response.audio.done',
  'response.audio_transcript.delta',
  'response.audio_transcript.done',
  'conversation.item.input_audio_transcription.delta',
  'conversation.item.input_audio_transcription.completed',
  'conversation.item.created',
  'response.function_call_arguments.done',
  'response.done',
  'error',
]);

export interface RealtimeConnection {
  url: string;
  /** WebSocket subprotocols, when auth rides there. */
  protocols?: string[];
}

export abstract class BaseRealtimeSession implements RealtimeSession {
  protected ws: WebSocket | null = null;
  protected readonly mic = new MicCapture();
  protected readonly playback = new AudioPlayback();
  private readonly assistantTranscripts = new Map<string, string>();
  private userTranscript = '';
  private userTranscriptTurn = 0;
  private assistantResponseTurn = 0;
  private speaking = false;
  private connected = false;
  private responseAudio: Int16Array[] = [];
  private responseAudioBytes = 0;
  private responseText: string[] = [];
  private responseAudioDiscarded = false;
  private responseInProgress = false;

  constructor(protected readonly options: RealtimeSessionOptions) {}

  isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    // Mic + playback both prepared inside the "开始通话" click's user-activation
    // window: getUserMedia needs it, and the output AudioContext must be resumed
    // here or Chrome's autoplay policy leaves it silently suspended. Mic frames
    // flow only once `onFrame` attaches after the socket opens.
    await this.mic.start();
    await this.playback.prepare();

    const { url, protocols } = await this.buildConnection();
    const connectionUrl = applyWebSocketProxy(url);
    const ws = protocols ? new WebSocket(connectionUrl, protocols) : new WebSocket(connectionUrl);
    this.ws = ws;

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;

        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          // Drop the handlers so the close we trigger below doesn't re-enter
          // onClose and stomp the error state the caller is about to set.
          ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
          try {
            ws.close();
          } catch {
            /* already closing */
          }
          reject(error);
        };

        const timer = setTimeout(
          () =>
            fail(
              new Error(
                '连接超时。网络可能不稳定（中国大陆访问海外服务时较常见），请检查网络或使用加速工具后重试。',
              ),
            ),
          CONNECT_TIMEOUT_MS,
        );

        ws.onopen = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.connected = true;
          this.send(this.buildSessionUpdate());
          this.mic.onFrame((frame) => this.sendAudioFrame(frame));
          this.options.events.onOpen?.();
          resolve();
        };
        ws.onmessage = (event) => {
          if (typeof event.data === 'string') this.handleMessage(event.data);
        };
        ws.onerror = () => {
          this.options.events.onError?.(new Error('实时语音连接出错'));
          if (!this.connected) fail(new Error('实时语音连接出错'));
        };
        ws.onclose = (event) => {
          this.connected = false;
          this.mic.stop();
          this.playback.close();
          if (this.ws === ws) this.ws = null;
          this.options.events.onClose?.(event.reason || '连接已关闭');
          if (!this.connected) fail(new Error(event.reason || '连接已关闭'));
        };
      });
    } catch (error) {
      // A failed handshake must not leave the mic hot / the output context open —
      // both were started before the socket, so tear them down here instead of
      // leaking them.
      this.mic.stop();
      this.playback.close();
      throw error;
    }
  }

  disconnect(): void {
    this.connected = false;
    this.mic.stop();
    this.playback.close();
    this.resetResponseAudio();
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
    this.send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output },
    });
  }

  requestResponse(): void {
    this.send({ type: 'response.create' });
  }

  whenAudioDrained(): Promise<void> {
    return this.playback.whenDrained();
  }

  updateInstructions(instructions: string): void {
    this.updateConfiguration({ instructions, tools: this.options.tools });
  }

  updateConfiguration(configuration: { instructions: string; tools: ToolDefinition[] }): void {
    this.options.instructions = configuration.instructions;
    this.options.tools = configuration.tools;
    this.send(this.buildSessionUpdate());
  }

  protected send(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  /** Tools declared flat, not nested under a `function` object. */
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
    this.send({
      type: 'input_audio_buffer.append',
      audio: this.encodeAudioFrame(float32ToInt16(frame)),
    });
  }

  private handleMessage(raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    const type = canonicalEventType(message.type);
    if (!KNOWN_EVENT_TYPES.has(type)) {
      // The event type only. Realtime payloads carry transcripts of what the
      // user said, and this fires on a live call — dumping the whole object
      // put that in the console of a shipped build. The full message is
      // still there in a dev build, where the log is actually being read.
      if (import.meta.env.DEV) {
        console.log('[dg-voice] unhandled realtime event:', message.type, message);
      } else {
        console.warn('[dg-voice] unhandled realtime event:', message.type);
      }
    } else if (import.meta.env.DEV) {
      console.debug('[dg-voice] realtime event:', message.type);
    }

    const itemId = typeof message.item_id === 'string' ? message.item_id : undefined;

    switch (type) {
      case 'input_audio_buffer.speech_started':
        this.options.events.onUserTurnStarted?.();
        // Barge-in: the user started talking over the assistant — cut audio now.
        this.playback.clear();
        if (this.responseInProgress) {
          this.responseAudioDiscarded = true;
          this.responseAudio = [];
          this.responseAudioBytes = 0;
        }
        this.setSpeaking(false);
        break;

      case 'response.created':
        this.responseInProgress = true;
        break;

      case 'response.audio.delta': {
        // Output is raw pcm16 24kHz — decode straight to playback.
        const delta = message.delta ?? message.audio;
        if (typeof delta === 'string') {
          this.responseInProgress = true;
          const pcm = base64ToInt16(delta);
          if (this.options.tools.some((tool) => isDeviceToolName(tool.name))) {
            // 3 MiB bounds a long or malformed provider response. Never play
            // a partial buffered response after exceeding the limit.
            if (!this.responseAudioDiscarded) {
              this.responseAudioBytes += pcm.byteLength;
              if (this.responseAudioBytes > 3 * 1024 * 1024) {
                this.responseAudioDiscarded = true;
                this.responseAudio = [];
              } else this.responseAudio.push(pcm);
            }
          } else if (!this.responseAudioDiscarded) {
            this.playback.enqueuePcm16(pcm);
            this.setSpeaking(true);
          }
        }
        break;
      }

      case 'response.audio_transcript.delta': {
        this.responseInProgress = true;
        if (typeof message.delta === 'string') this.emitAssistantDelta(itemId, message.delta);
        break;
      }
      case 'response.audio_transcript.done': {
        this.responseInProgress = true;
        this.emitAssistantDone(
          itemId,
          typeof message.transcript === 'string' ? message.transcript : undefined,
        );
        break;
      }

      case 'conversation.item.created': {
        // Reserve the user's transcript line NOW, in order. An upstream may
        // stream the assistant reply BEFORE the user's input transcription
        // (which arrives late), so without an early placeholder the user's line
        // gets appended below the reply. This event carries the item in
        // `item.id` (not `message.item_id`) and fires before the response.
        const item = message.item as { id?: unknown; role?: unknown } | undefined;
        if (item && item.role === 'user' && typeof item.id === 'string') {
          this.options.events.onTranscript?.({
            id: userTranscriptId(item.id, this.userTranscriptTurn),
            role: 'user',
            text: '',
            done: false,
          });
        }
        break;
      }

      case 'conversation.item.input_audio_transcription.delta': {
        if (typeof message.delta === 'string') {
          this.userTranscript += message.delta;
          this.options.events.onTranscript?.({
            id: userTranscriptId(itemId, this.userTranscriptTurn),
            role: 'user',
            text: this.userTranscript,
            done: false,
          });
        }
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const transcript =
          typeof message.transcript === 'string' ? message.transcript : this.userTranscript;
        this.options.events.onTranscript?.({
          id: userTranscriptId(itemId, this.userTranscriptTurn),
          role: 'user',
          text: transcript,
          done: true,
        });
        this.userTranscript = '';
        this.userTranscriptTurn++;
        break;
      }

      case 'response.function_call_arguments.done': {
        const name = message.name;
        const args = message.arguments;
        if (typeof name === 'string' && typeof args === 'string') {
          this.options.events.onFunctionCall?.({
            callId: typeof message.call_id === 'string' ? message.call_id : 'call',
            name,
            argsJson: args,
          });
        }
        break;
      }

      case 'response.audio.done':
        break;

      case 'response.done':
        this.flushAssistantTranscripts();
        if (
          this.responseAudio.length &&
          !this.responseAudioDiscarded &&
          this.options.events.onAuthorizeAudio?.(this.responseText.join('\n')) === true
        ) {
          for (const pcm of this.responseAudio) this.playback.enqueuePcm16(pcm);
          this.setSpeaking(true);
        }
        this.resetResponseAudio();
        this.assistantResponseTurn++;
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
    const key = itemId ?? `assistant-pending-${this.assistantResponseTurn}`;
    const text = (this.assistantTranscripts.get(key) ?? '') + delta;
    this.assistantTranscripts.set(key, text);
    this.options.events.onTranscript?.({
      id: assistantTranscriptId(key),
      role: 'assistant',
      text,
      done: false,
    });
  }

  private emitAssistantDone(itemId: string | undefined, finalText?: string): void {
    const key = itemId ?? `assistant-pending-${this.assistantResponseTurn}`;
    const text = finalText ?? this.assistantTranscripts.get(key) ?? '';
    this.assistantTranscripts.delete(key);
    if (text) {
      this.responseText.push(text);
      this.options.events.onTranscript?.({
        id: assistantTranscriptId(key),
        role: 'assistant',
        text,
        done: true,
      });
    }
  }

  /** A response can end without a per-item `.done` — mark any still-streaming assistant lines complete. */
  private flushAssistantTranscripts(): void {
    for (const [key, text] of [...this.assistantTranscripts]) {
      this.assistantTranscripts.delete(key);
      if (text) {
        this.responseText.push(text);
        this.options.events.onTranscript?.({
          id: assistantTranscriptId(key),
          role: 'assistant',
          text,
          done: true,
        });
      }
    }
  }

  private setSpeaking(speaking: boolean): void {
    if (this.speaking === speaking) return;
    this.speaking = speaking;
    this.options.events.onSpeakingChange?.(speaking);
  }

  private resetResponseAudio(): void {
    this.responseAudio = [];
    this.responseAudioBytes = 0;
    this.responseText = [];
    this.responseAudioDiscarded = false;
    this.responseInProgress = false;
  }

  // ---- wire hooks ----

  protected abstract buildConnection(): Promise<RealtimeConnection>;
  protected abstract buildSessionUpdate(): Record<string, unknown>;
  /** Input frame -> base64 payload for `input_audio_buffer.append`. */
  protected abstract encodeAudioFrame(int16: Int16Array): string;
}
