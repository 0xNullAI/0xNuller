/**
 * `RealtimeSession` implementation for the `openai-realtime` dialect — xAI,
 * OpenAI, and Azure OpenAI all speak the same event shapes, so this one
 * class serves all three; only `buildWsUrl`/`mintCredential` branch on
 * provider id.
 *
 * Uses the classic/stable OpenAI Realtime "beta" event vocabulary (flat
 * `session.update` fields — `voice`/`input_audio_format`/`turn_detection` at
 * the top level of `session`, not nested under an `audio` object; event
 * names like `response.audio.delta`/`response.audio_transcript.delta`, not
 * `response.output_audio.*`) rather than a newer/GA-shaped schema this file
 * originally guessed at — a live test against a real xAI key came back
 * "Invalid event received" for the newer nested-`audio` shape, which is
 * strong evidence xAI mirrors the classic schema (matching their own
 * "OpenAI Realtime compatible" claim, which predates any nested-audio GA
 * schema). Still not fully live-verified end-to-end — if you get a new
 * server-side rejection, log the raw `error` event payload and check this
 * file's `sendSessionUpdate()`/`handleMessage()` first.
 */
import type { ToolDefinition } from '@dg-kit/core';
import { AudioPlayback, MicCapture, base64ToInt16, float32ToInt16, int16ToBase64 } from './audio.js';
import {
  mintAzureRealtimeEphemeralToken,
  mintOpenAiRealtimeEphemeralToken,
  mintXaiRealtimeEphemeralToken,
} from './ephemeral-token.js';
import type { RealtimeProviderId, RealtimeProviderSettings } from './providers.js';
import type { RealtimeSession, RealtimeSessionEvents } from './realtime-session.js';

function buildWsUrl(providerId: RealtimeProviderId, settings: RealtimeProviderSettings): string {
  switch (providerId) {
    case 'xai':
      return `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(settings.model)}`;
    case 'openai':
      return `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(settings.model)}`;
    case 'azure': {
      const host = settings.baseUrl.replace(/^https?:\/\//, '');
      return `wss://${host}/openai/realtime?api-version=2025-04-01-preview&deployment=${encodeURIComponent(
        settings.deployment,
      )}`;
    }
    case 'zhipu':
      throw new Error('智谱 GLM 走 glm-realtime 方言，不应使用 OpenAiRealtimeSession');
  }
}

/**
 * Ephemeral-token mint first (keeps the long-lived BYO key off the WS
 * handshake); if minting fails for any reason (wrong endpoint shape, CORS,
 * account not enabled for it, ...) falls back to the raw API key as the
 * subprotocol credential — the retreat this scaffold's plan called out
 * explicitly rather than hard-failing the call.
 */
async function resolveCredential(
  providerId: RealtimeProviderId,
  settings: RealtimeProviderSettings,
): Promise<string> {
  try {
    switch (providerId) {
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
    console.warn(
      `[dg-voice] ${providerId} 换票失败，回退为直接用 API Key 作为 WebSocket 凭据：`,
      error,
    );
    return settings.apiKey;
  }
}

const SILENCE_DURATION_MS = 500;
const VAD_THRESHOLD = 0.85;
const VAD_PREFIX_PADDING_MS = 333;

export class OpenAiRealtimeSession implements RealtimeSession {
  private ws: WebSocket | null = null;
  private readonly mic = new MicCapture();
  private readonly playback = new AudioPlayback();
  private assistantTranscript = '';
  private userTranscript = '';
  private speaking = false;
  private connected = false;

  constructor(
    private readonly providerId: RealtimeProviderId,
    private readonly options: {
      settings: RealtimeProviderSettings;
      tools: ToolDefinition[];
      instructions: string;
      events: RealtimeSessionEvents;
    },
  ) {}

  isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    // Open the mic before the socket exists — frames buffer inside
    // `MicCapture` until `onFrame` is attached in `onopen` below, per xAI's
    // own recommendation not to wait on the WS before capturing audio.
    await this.mic.start();
    // Must happen inside the "开始通话" click's transient user-activation
    // window, not lazily on the first audio delta — see AudioPlayback.prepare().
    await this.playback.prepare();

    const credential = await resolveCredential(this.providerId, this.options.settings);
    const wsUrl = buildWsUrl(this.providerId, this.options.settings);
    const ws = new WebSocket(wsUrl, ['realtime', `openai-insecure-api-key.${credential}`]);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        this.connected = true;
        this.sendSessionUpdate();
        this.mic.onFrame((frame) => this.sendAudioFrame(frame));
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
        this.options.events.onClose?.(event.reason || '连接已关闭');
      };
    });
  }

  disconnect(): void {
    this.connected = false;
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
    this.options.instructions = instructions;
    this.sendSessionUpdate();
  }

  private sendSessionUpdate(): void {
    // Classic/stable Realtime session shape — flat fields, no `audio.input`/
    // `audio.output` nesting, no `model` inside `session` (the model is
    // already pinned via the `?model=` query param at connect time). `speed`
    // isn't part of this schema at all — there is no known mechanism for it
    // here, so the setting is currently not applied for this dialect; see
    // CLAUDE.md before re-adding it without live verification.
    this.send({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: this.options.instructions,
        voice: this.options.settings.voice,
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: VAD_THRESHOLD,
          prefix_padding_ms: VAD_PREFIX_PADDING_MS,
          silence_duration_ms: SILENCE_DURATION_MS,
        },
        tools: this.options.tools.map((tool) => ({
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
        tool_choice: 'auto',
      },
    });
  }

  private sendAudioFrame(frame: Float32Array): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const int16 = float32ToInt16(frame);
    this.send({ type: 'input_audio_buffer.append', audio: int16ToBase64(int16) });
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private handleMessage(raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    switch (message.type) {
      case 'input_audio_buffer.speech_started':
        // Barge-in: the user started talking over the assistant — cut audio now.
        this.playback.clear();
        this.setSpeaking(false);
        break;

      case 'response.audio.delta': {
        const delta = message.delta;
        if (typeof delta === 'string') {
          this.playback.enqueuePcm16(base64ToInt16(delta));
          this.setSpeaking(true);
        }
        break;
      }

      case 'response.audio_transcript.delta': {
        const delta = message.delta;
        if (typeof delta === 'string') {
          this.assistantTranscript += delta;
          this.options.events.onAssistantTranscript?.(this.assistantTranscript, false);
        }
        break;
      }
      case 'response.audio_transcript.done': {
        const transcript = typeof message.transcript === 'string' ? message.transcript : this.assistantTranscript;
        this.options.events.onAssistantTranscript?.(transcript, true);
        this.assistantTranscript = '';
        break;
      }

      case 'conversation.item.input_audio_transcription.delta': {
        const delta = message.delta;
        if (typeof delta === 'string') {
          this.userTranscript += delta;
          this.options.events.onUserTranscript?.(this.userTranscript, false);
        }
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const transcript = typeof message.transcript === 'string' ? message.transcript : this.userTranscript;
        this.options.events.onUserTranscript?.(transcript, true);
        this.userTranscript = '';
        break;
      }

      case 'response.function_call_arguments.done': {
        const callId = message.call_id;
        const name = message.name;
        const args = message.arguments;
        if (typeof callId === 'string' && typeof name === 'string' && typeof args === 'string') {
          this.options.events.onFunctionCall?.({ callId, name, argsJson: args });
        }
        break;
      }

      case 'response.done':
        // Audio for this response may still be draining out of the playback
        // queue — flip the "speaking" indicator off only once it actually is.
        void this.playback.whenDrained().then(() => this.setSpeaking(false));
        this.options.events.onResponseDone?.();
        break;

      case 'error': {
        // Log the full payload (not just `.message`) — `code`/`param`/`event_id`
        // are what actually pin down which field of a rejected session.update
        // (or other client event) the server didn't like.
        console.error('[dg-voice] realtime error event:', message);
        const error = message.error as { message?: string } | undefined;
        this.options.events.onError?.(new Error(error?.message ?? '服务端返回未知错误'));
        break;
      }

      default:
        // Unhandled event types (session.created, response.done, rate_limits.updated, ...)
        // carry no action DG-Voice needs to take.
        break;
    }
  }

  private setSpeaking(speaking: boolean): void {
    if (this.speaking === speaking) return;
    this.speaking = speaking;
    this.options.events.onSpeakingChange?.(speaking);
  }
}
