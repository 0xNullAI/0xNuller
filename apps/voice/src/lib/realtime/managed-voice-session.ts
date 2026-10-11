/**
 * 猫愿语音 client. The browser connects only to our Voice Worker
 * (`/api/realtime`) with a short-lived account ticket; the Worker validates,
 * meters, and opens the upstream connection with a key that never reaches the
 * client (see `worker/managed-session.ts`, which owns the upstream choice).
 *
 * This class defines the Worker's client-facing protocol: the classic flat
 * realtime `session.update`, pcm16 24kHz audio in both directions, and
 * subprotocol auth. All WS lifecycle, event handling, transcripts, and the
 * device-audio gate live in `BaseRealtimeSession`. If the Worker's upstream
 * changes, either keep this protocol and translate in the Worker, or change
 * only the three hooks below.
 */
import {
  BaseRealtimeSession,
  VAD_PREFIX_PADDING_MS,
  VAD_SILENCE_DURATION_MS,
  VAD_THRESHOLD,
  type RealtimeConnection,
} from './base-realtime-session.js';
import { int16ToBase64 } from './audio.js';
import { apiWsUrl } from '@0xnullai/settings';
import { getVoiceTicket } from '@0xnullai/auth';

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

export class ManagedVoiceSession extends BaseRealtimeSession {
  protected async buildConnection(): Promise<RealtimeConnection> {
    const { ticket } = await getVoiceTicket();
    // **Do NOT build a same-origin URL from `location.host` here.** It works on
    // the web, but the Tauri shell's origin is a local scheme, so that would
    // connect to `wss://tauri.localhost/api/realtime`.
    const url = new URL(apiWsUrl('/api/realtime'));
    if (this.options.billingContext) {
      url.searchParams.set('conversationId', this.options.billingContext.conversationId);
      url.searchParams.set('runId', this.options.billingContext.runId);
    }
    return {
      url: url.toString(),
      protocols: ['realtime', `openai-insecure-api-key.${ticket}`],
    };
  }

  protected encodeAudioFrame(int16: Int16Array): string {
    return int16ToBase64(int16);
  }

  protected buildSessionUpdate(): Record<string, unknown> {
    return {
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: this.options.instructions,
        voice: this.options.voice,
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: TURN_DETECTION,
        tools: this.mappedTools(),
        tool_choice: 'auto',
      },
    };
  }
}
