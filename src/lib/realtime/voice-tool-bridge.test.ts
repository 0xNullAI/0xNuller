import { describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '@dg-kit/core';
import type { RealtimeSession } from './realtime-session.js';
import { VoiceToolBridge, type ToolExecutorLike } from './voice-tool-bridge.js';

function createFakeSession(overrides: Partial<RealtimeSession> = {}): RealtimeSession {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    sendFunctionCallOutput: vi.fn(),
    requestResponse: vi.fn(),
    whenAudioDrained: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    updateInstructions: vi.fn(),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('VoiceToolBridge', () => {
  it('does not call requestResponse for a response cycle with no tool calls', async () => {
    const session = createFakeSession();
    const executor: ToolExecutorLike = { execute: vi.fn() };
    const bridge = new VoiceToolBridge(session, executor);

    bridge.handleResponseDone();
    await flushMicrotasks();

    expect(session.requestResponse).not.toHaveBeenCalled();
  });

  it('sends function_call_output and requests a response after a single tool call resolves', async () => {
    const session = createFakeSession();
    const executor: ToolExecutorLike = {
      execute: vi.fn().mockResolvedValue({ toolCallId: 'call-1', output: '{"ok":true}' }),
    };
    const bridge = new VoiceToolBridge(session, executor);

    bridge.handleFunctionCall({ callId: 'call-1', name: 'shock_stop', argsJson: '{}' });
    bridge.handleResponseDone();
    await flushMicrotasks();

    expect(executor.execute).toHaveBeenCalledWith({ id: 'call-1', name: 'shock_stop', args: {} });
    expect(session.sendFunctionCallOutput).toHaveBeenCalledWith('call-1', '{"ok":true}');
    expect(session.requestResponse).toHaveBeenCalledTimes(1);
  });

  it('waits for ALL parallel tool calls to resolve before requesting a response', async () => {
    const session = createFakeSession();
    const first = deferred<{ toolCallId: string; output: string }>();
    const second = deferred<{ toolCallId: string; output: string }>();
    const execute = vi.fn().mockImplementation((call: ToolCall) => {
      return call.id === 'call-1' ? first.promise : second.promise;
    });
    const bridge = new VoiceToolBridge(session, { execute });

    bridge.handleFunctionCall({ callId: 'call-1', name: 'shock_adjust', argsJson: '{}' });
    bridge.handleFunctionCall({ callId: 'call-2', name: 'vibrate_adjust', argsJson: '{}' });
    bridge.handleResponseDone();
    await flushMicrotasks();

    expect(session.requestResponse).not.toHaveBeenCalled();

    first.resolve({ toolCallId: 'call-1', output: '{}' });
    await flushMicrotasks();
    expect(session.requestResponse).not.toHaveBeenCalled(); // second still pending

    second.resolve({ toolCallId: 'call-2', output: '{}' });
    await flushMicrotasks();
    expect(session.requestResponse).toHaveBeenCalledTimes(1);
  });

  it('waits for audio to drain before requesting a response', async () => {
    const drain = deferred<void>();
    const session = createFakeSession({ whenAudioDrained: vi.fn().mockReturnValue(drain.promise) });
    const executor: ToolExecutorLike = {
      execute: vi.fn().mockResolvedValue({ toolCallId: 'call-1', output: '{}' }),
    };
    const bridge = new VoiceToolBridge(session, executor);

    bridge.handleFunctionCall({ callId: 'call-1', name: 'shock_stop', argsJson: '{}' });
    bridge.handleResponseDone();
    await flushMicrotasks();

    expect(session.requestResponse).not.toHaveBeenCalled();

    drain.resolve();
    await flushMicrotasks();
    expect(session.requestResponse).toHaveBeenCalledTimes(1);
  });

  it('sends an error payload instead of throwing when the executor rejects', async () => {
    const session = createFakeSession();
    const executor: ToolExecutorLike = { execute: vi.fn().mockRejectedValue(new Error('boom')) };
    const bridge = new VoiceToolBridge(session, executor);

    bridge.handleFunctionCall({ callId: 'call-1', name: 'shock_stop', argsJson: '{}' });
    bridge.handleResponseDone();
    await flushMicrotasks();

    expect(session.sendFunctionCallOutput).toHaveBeenCalledWith('call-1', JSON.stringify({ error: 'boom' }));
    expect(session.requestResponse).toHaveBeenCalledTimes(1);
  });

  it('falls back to an empty args object for malformed JSON instead of throwing', async () => {
    const session = createFakeSession();
    const executor: ToolExecutorLike = {
      execute: vi.fn().mockResolvedValue({ toolCallId: 'call-1', output: '{}' }),
    };
    const bridge = new VoiceToolBridge(session, executor);

    bridge.handleFunctionCall({ callId: 'call-1', name: 'shock_stop', argsJson: 'not json' });
    await flushMicrotasks();

    expect(executor.execute).toHaveBeenCalledWith({ id: 'call-1', name: 'shock_stop', args: {} });
  });

  it('runs a second response cycle independently after the first completes', async () => {
    const session = createFakeSession();
    const executor: ToolExecutorLike = {
      execute: vi.fn().mockResolvedValue({ toolCallId: 'x', output: '{}' }),
    };
    const bridge = new VoiceToolBridge(session, executor);

    bridge.handleFunctionCall({ callId: 'call-1', name: 'shock_stop', argsJson: '{}' });
    bridge.handleResponseDone();
    await flushMicrotasks();
    expect(session.requestResponse).toHaveBeenCalledTimes(1);

    // Second cycle: a plain speech turn with no tool call must not re-trigger requestResponse.
    bridge.handleResponseDone();
    await flushMicrotasks();
    expect(session.requestResponse).toHaveBeenCalledTimes(1);

    // Third cycle: another tool call.
    bridge.handleFunctionCall({ callId: 'call-2', name: 'shock_stop', argsJson: '{}' });
    bridge.handleResponseDone();
    await flushMicrotasks();
    expect(session.requestResponse).toHaveBeenCalledTimes(2);
  });
});

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}
