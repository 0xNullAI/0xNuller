import type { ToolDefinition } from '@dg-kit/core';

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
  /** Fail-closed playback gate for a completed device-capable audio response. */
  onAuthorizeAudio?(transcript: string): boolean;
  /** Assistant audio started/stopped playing — drives the call UI's "speaking" indicator. */
  onSpeakingChange?(speaking: boolean): void;
  /**
   * The current response cycle finished. `VoiceToolBridge` uses this (paired
   * with all in-flight tool executions resolving) to know when it's safe to
   * send `function_call_output` items and call `requestResponse()` — calling
   * it mid-cycle would race with a response that's still being generated.
   */
  onResponseDone?(): void;
  /**
   * The user started a new spoken turn (server or client voice activity). Evidence from
   * tool calls belongs to one user turn; transcription events arrive too late to mark it.
   */
  onUserTurnStarted?(): void;
}

/**
 * Realtime voice connection. `VoiceToolBridge` and the call UI only ever talk
 * to this interface; `ManagedVoiceSession` implements it against our Worker.
 */
export interface RealtimeSession {
  connect(): Promise<void>;
  disconnect(): void;
  sendFunctionCallOutput(callId: string, output: string): void;
  /**
   * Explicit "generate the next turn" step, required after a tool result. A
   * protocol that auto-continues would implement this as a no-op.
   */
  requestResponse(): void;
  /** Resolves once all currently-queued assistant audio has finished playing. */
  whenAudioDrained(): Promise<void>;
  isConnected(): boolean;
  /**
   * Re-sends `session.update` with fresh instructions (same tools/voice,
   * just the instructions text) — used to keep the live device-status block
   * in `build-voice-instructions.ts` current as strength/connection state
   * changes mid-call. Safe to call as often as the debounced caller wants.
   */
  updateInstructions(instructions: string): void;
  /** Atomically refreshes the model-visible instructions and tool allowlist. */
  updateConfiguration(configuration: { instructions: string; tools: ToolDefinition[] }): void;
}

export interface RealtimeSessionOptions {
  billingContext?: { conversationId: string; runId: string };
  /** Voice id from `managed-voices.ts`. */
  voice: string;
  tools: ToolDefinition[];
  instructions: string;
  events: RealtimeSessionEvents;
}

/** Lazily loads the session implementation, keeping audio/WS code out of the initial bundle. */
export async function createRealtimeSession(
  options: RealtimeSessionOptions,
): Promise<RealtimeSession> {
  const { ManagedVoiceSession } = await import('./managed-voice-session.js');
  return new ManagedVoiceSession(options);
}
