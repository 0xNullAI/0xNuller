import type { ToolDefinition } from '@dg-kit/core';
import { getRealtimeProviderDefinition, type RealtimeProviderSettings } from './providers.js';

export interface RealtimeFunctionCall {
  callId: string;
  name: string;
  argsJson: string;
}

/**
 * One line of the running conversation. `id` is the provider's `item_id`
 * where available so streaming deltas accumulate into the same entry
 * instead of replacing the previous turn — the UI keeps a list keyed on it.
 */
export interface RealtimeTranscriptEntry {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  done: boolean;
}

export interface RealtimeSessionEvents {
  onOpen?(): void;
  onClose?(reason: string): void;
  onError?(error: Error): void;
  onFunctionCall?(call: RealtimeFunctionCall): void;
  onTranscript?(entry: RealtimeTranscriptEntry): void;
  /** Assistant audio started/stopped playing — drives the call UI's "speaking" indicator. */
  onSpeakingChange?(speaking: boolean): void;
  /**
   * The current response cycle finished. `VoiceToolBridge` uses this (paired
   * with all in-flight tool executions resolving) to know when it's safe to
   * send `function_call_output` items and call `requestResponse()` — calling
   * it mid-cycle would race with a response that's still being generated.
   */
  onResponseDone?(): void;
}

/**
 * Dialect-agnostic realtime voice connection. `VoiceToolBridge` and the call
 * UI only ever talk to this interface — `OpenAIRealtimeSession` (xAI/OpenAI/
 * Azure) and `GlmRealtimeSession` (Zhipu) are interchangeable behind it.
 */
export interface RealtimeSession {
  connect(): Promise<void>;
  disconnect(): void;
  sendFunctionCallOutput(callId: string, output: string): void;
  /**
   * Explicit "generate the next turn" step. OpenAI-family dialects require
   * this after a tool result; some other realtime APIs (not currently
   * supported by DG-Voice, but the interface leaves room) auto-continue and
   * would implement this as a no-op — see the provider-catalog notes in
   * `providers.ts` for why DG-Voice only ships the two dialects that need
   * this method to actually do something.
   */
  requestResponse(): void;
  /** Resolves once all currently-queued assistant audio has finished playing. */
  whenAudioDrained(): Promise<void>;
  isConnected(): boolean;
  /**
   * Re-sends `session.update` with fresh instructions (same tools/voice,
   * just the instructions text) — used to keep the live device-status block
   * in `build-voice-instructions.ts` current as strength/connection state
   * changes mid-call. Both dialects support updating `instructions` after
   * connect; safe to call as often as the debounced caller wants.
   */
  updateInstructions(instructions: string): void;
}

export interface RealtimeSessionOptions {
  settings: RealtimeProviderSettings;
  tools: ToolDefinition[];
  instructions: string;
  events: RealtimeSessionEvents;
}

/** Picks the dialect implementation for `settings.providerId` — the only place that needs to know both classes exist. */
export async function createRealtimeSession(options: RealtimeSessionOptions): Promise<RealtimeSession> {
  const definition = getRealtimeProviderDefinition(options.settings.providerId);
  if (!definition) {
    throw new Error(`未知的语音 provider：${options.settings.providerId}`);
  }

  if (definition.dialect === 'glm-realtime') {
    const { GlmRealtimeSession } = await import('./glm-realtime-session.js');
    return new GlmRealtimeSession(options);
  }

  const { OpenAiRealtimeSession } = await import('./openai-realtime-session.js');
  return new OpenAiRealtimeSession(options.settings.providerId, options);
}
