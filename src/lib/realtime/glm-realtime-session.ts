/**
 * `RealtimeSession` implementation for Zhipu's `glm-realtime` dialect.
 *
 * NOT LIVE-VERIFIED (lower confidence than the openai-realtime dialect — no
 * account was available to test against). Differences from openai-realtime,
 * per the plan this was scaffolded from:
 *  - audio is wav-framed, not raw pcm16 (`wrapPcm16AsWav`)
 *  - auth is a `?Authorization=<jwt>` query param, not a WS subprotocol —
 *    the JWT is signed locally (`signZhipuJwt`), so there is no ephemeral-
 *    token round trip at all for this provider
 *  - extra top-level session fields: `tts_source: 'e2e'`, `chat_mode: 'audio'`
 *  - a `heartbeat` server event arrives roughly every 30s and must be
 *    tolerated (ignored) rather than treated as an error
 *  - function-call arguments arrive only as `.done` events (no `.delta`
 *    streaming) — handled identically to how the openai dialect treats its
 *    own `.done` event, so no extra aggregation code is needed here
 *  - an extra `response.function_call.simple_browser` event (GLM's built-in
 *    web search) is explicitly ignored
 * Every other event name matches openai-realtime.
 */
import type { ToolDefinition } from '@dg-kit/core';
import { AudioPlayback, MicCapture, base64ToInt16, float32ToInt16, wrapPcm16AsWav } from './audio.js';
import type { RealtimeProviderSettings } from './providers.js';
import type { RealtimeSession, RealtimeSessionEvents } from './realtime-session.js';
import { signZhipuJwt } from './zhipu-jwt.js';

const GLM_REALTIME_WS_URL = 'wss://open.bigmodel.cn/api/paas/v4/realtime';
const HEARTBEAT_INTERVAL_MS = 30_000;

function wavToBase64(wav: ArrayBuffer): string {
  const bytes = new Uint8Array(wav);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export class GlmRealtimeSession implements RealtimeSession {
  private ws: WebSocket | null = null;
  private readonly mic = new MicCapture();
  private readonly playback = new AudioPlayback();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private assistantTranscript = '';
  private userTranscript = '';
  private speaking = false;
  private connected = false;

  constructor(
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
    await this.mic.start();

    const jwt = await signZhipuJwt(this.options.settings.apiKey);
    const ws = new WebSocket(`${GLM_REALTIME_WS_URL}?Authorization=${encodeURIComponent(jwt)}`);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        this.connected = true;
        this.sendSessionUpdate();
        this.mic.onFrame((frame) => this.sendAudioFrame(frame));
        this.startHeartbeat();
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
        this.stopHeartbeat();
        this.options.events.onClose?.(event.reason || '连接已关闭');
      };
    });
  }

  disconnect(): void {
    this.connected = false;
    this.stopHeartbeat();
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

  private sendSessionUpdate(): void {
    this.send({
      type: 'session.update',
      session: {
        model: this.options.settings.model,
        instructions: this.options.instructions,
        tools: this.options.tools.map((tool) => ({
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
        tool_choice: 'auto',
        tts_source: 'e2e',
        chat_mode: 'audio',
        audio: {
          input: {
            format: 'wav',
            turn_detection: { type: 'server_vad' },
          },
          output: {
            format: 'wav',
            voice: this.options.settings.voice,
          },
        },
      },
    });
  }

  private sendAudioFrame(frame: Float32Array): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const int16 = float32ToInt16(frame);
    const wav = wrapPcm16AsWav(int16);
    this.send({ type: 'input_audio_buffer.append', audio: wavToBase64(wav) });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'heartbeat' });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
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
      case 'heartbeat':
        // Server keepalive ping — no action needed.
        break;

      case 'response.function_call.simple_browser':
        // GLM's built-in web search tool call — DG-Voice doesn't expose
        // browsing, so this is intentionally ignored rather than surfaced
        // as an unknown function call.
        break;

      case 'input_audio_buffer.speech_started':
        this.playback.clear();
        this.setSpeaking(false);
        break;

      case 'response.output_audio.delta': {
        const delta = message.delta;
        if (typeof delta === 'string') {
          // GLM sends wav-framed output too; strip the 44-byte header before
          // decoding as raw pcm16 for playback.
          const wavBytes = base64ToInt16(delta);
          this.playback.enqueuePcm16(wavBytes.subarray(22));
          this.setSpeaking(true);
        }
        break;
      }

      case 'response.output_audio_transcript.delta': {
        const delta = message.delta;
        if (typeof delta === 'string') {
          this.assistantTranscript += delta;
          this.options.events.onAssistantTranscript?.(this.assistantTranscript, false);
        }
        break;
      }
      case 'response.output_audio_transcript.done': {
        const transcript = typeof message.transcript === 'string' ? message.transcript : this.assistantTranscript;
        this.options.events.onAssistantTranscript?.(transcript, true);
        this.assistantTranscript = '';
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
        void this.playback.whenDrained().then(() => this.setSpeaking(false));
        this.options.events.onResponseDone?.();
        break;

      case 'error': {
        const error = message.error as { message?: string } | undefined;
        this.options.events.onError?.(new Error(error?.message ?? '服务端返回未知错误'));
        break;
      }

      default:
        break;
    }
  }

  private setSpeaking(speaking: boolean): void {
    if (this.speaking === speaking) return;
    this.speaking = speaking;
    this.options.events.onSpeakingChange?.(speaking);
  }
}
