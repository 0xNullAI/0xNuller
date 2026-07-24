/**
 * Wires a `RealtimeSession`'s tool-call events to a `ToolExecutor` — this is
 * an event handler, not a loop. It never decides whether/when the model
 * should speak or call a tool; it only reacts once the provider already has.
 *
 * The one piece of real sequencing logic here: a response cycle can request
 * several tools in parallel, and `response.create` must not be sent until
 * *every* one of them has both executed AND had its `function_call_output`
 * sent, AND any audio from the calling response has finished playing —
 * sending it early causes two responses' audio to overlap (the thing xAI's
 * own docs call out as the most common integration mistake).
 */
import type { ToolCall } from '@dg-kit/core';
import type { RealtimeFunctionCall, RealtimeSession } from './realtime-session.js';

export interface ToolExecutorLike {
  execute(toolCall: ToolCall): Promise<{ toolCallId: string; output: string }>;
}

export class VoiceToolBridge {
  private readonly pending = new Map<string, Promise<void>>();
  private hadCallThisCycle = false;
  private responseDone = false;

  constructor(
    private readonly session: RealtimeSession,
    private readonly executor: ToolExecutorLike,
  ) {}

  /** Registers this bridge as the session's function-call / response-done handler. Call once after constructing the session. */
  attach(events: { onFunctionCall?(call: RealtimeFunctionCall): void; onResponseDone?(): void }): {
    onFunctionCall(call: RealtimeFunctionCall): void;
    onResponseDone(): void;
  } {
    return {
      onFunctionCall: (call) => {
        events.onFunctionCall?.(call);
        this.handleFunctionCall(call);
      },
      onResponseDone: () => {
        events.onResponseDone?.();
        this.handleResponseDone();
      },
    };
  }

  handleFunctionCall(call: RealtimeFunctionCall): void {
    this.hadCallThisCycle = true;

    const toolCall: ToolCall = { id: call.callId, name: call.name, args: parseArgs(call.argsJson) };
    const task = this.executor
      .execute(toolCall)
      .then((result) => {
        this.session.sendFunctionCallOutput(call.callId, result.output);
      })
      .catch((error: unknown) => {
        this.session.sendFunctionCallOutput(
          call.callId,
          JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        );
      })
      .finally(() => {
        this.pending.delete(call.callId);
        void this.maybeAdvance();
      });

    this.pending.set(call.callId, task);
  }

  handleResponseDone(): void {
    this.responseDone = true;
    void this.maybeAdvance();
  }

  private async maybeAdvance(): Promise<void> {
    if (!this.hadCallThisCycle || !this.responseDone || this.pending.size > 0) return;

    // Reset before the await below so a synchronous re-entrant call in the
    // same tick sees a closed cycle instead of double-firing requestResponse().
    this.hadCallThisCycle = false;
    this.responseDone = false;

    await this.session.whenAudioDrained();
    this.session.requestResponse();
  }
}

function parseArgs(argsJson: string): Record<string, unknown> {
  if (!argsJson) return {};
  try {
    const parsed: unknown = JSON.parse(argsJson);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
