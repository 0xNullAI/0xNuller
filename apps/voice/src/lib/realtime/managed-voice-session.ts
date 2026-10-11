/**
 * 猫愿语音 client. The browser connects only to our Voice Worker
 * (`/api/realtime`) with a short-lived account ticket; the Worker validates,
 * meters, and opens the upstream connection with a key that never reaches the
 * client (see `worker/managed-session.ts`, which owns the upstream choice).
 *
 * This class defines the Worker's client-facing protocol: a flat `session.update`
 * (instructions, voice, flat tools), pcm16 audio (16 kHz in, 24 kHz out) and
 * subprotocol auth. The Worker translates it to the provider's protocol
 * (`worker/doubao-realtime.ts`); turn detection is the provider's own. All WS
 * lifecycle, event handling, transcripts, and the device-audio gate live in
 * `BaseRealtimeSession`.
 */
import { BaseRealtimeSession, type RealtimeConnection } from './base-realtime-session.js';
import { int16ToBase64 } from './audio.js';
import { apiWsUrl } from '@0xnullai/settings';
import { getVoiceTicket } from '@0xnullai/auth';

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
        instructions: this.options.instructions,
        voice: this.options.voice,
        tools: this.mappedTools(),
      },
    };
  }
}
