import { describe, expect, it, vi } from 'vitest';
import {
  createEmptyDeviceState,
  type LlmClient,
  type LlmConversationItem,
  type RuntimeEvent,
  type SessionSnapshot,
} from '@dg-agent/core';
import { RuntimeTurnCoordinator } from './runtime-turn-coordinator.js';
import { resolveToolCallConfig } from './tool-call-config.js';
import { ToolRegistry } from './tool-registry.js';

function createSession(): SessionSnapshot {
  return {
    id: 'turn-session',
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    deviceState: createEmptyDeviceState(),
  };
}

function createCoordinator(input: {
  llm: LlmClient;
  execute?: ReturnType<typeof vi.fn>;
  emit?: (event: RuntimeEvent) => void;
}) {
  const execute = input.execute ?? vi.fn(async () => JSON.stringify({ ok: true }));
  const saveSession = vi.fn(async () => undefined);
  const coordinator = new RuntimeTurnCoordinator({
    device: { getState: async () => createEmptyDeviceState() },
    llm: input.llm,
    toolRegistry: new ToolRegistry(),
    toolExecutor: {
      execute,
      getConnectedDeviceKinds: async () => new Set(),
    },
    toolCallConfig: resolveToolCallConfig({ maxToolIterations: 3 }),
    getInstructionDeviceState: async () => ({}),
    saveSession,
    emit: input.emit ?? (() => undefined),
  });

  return { coordinator, execute, saveSession };
}

const turn = {
  text: 'hello',
  context: { sessionId: 'turn-session', sourceType: 'user' as const, traceId: 'trace-turn' },
};

describe('RuntimeTurnCoordinator', () => {
  it('preserves model/session event order across a tool iteration and final reply', async () => {
    const conversations: LlmConversationItem[][] = [];
    const llm: LlmClient = {
      async runTurn(input) {
        conversations.push([...(input.conversation ?? [])]);
        if (conversations.length === 1) {
          return {
            assistantMessage: 'working',
            toolCalls: [{ id: 'call-1', name: 'timer', args: { seconds: 1, label: 'wait' } }],
          };
        }
        return { assistantMessage: 'done' };
      },
    };
    const eventTypes: RuntimeEvent['type'][] = [];
    const { coordinator, execute, saveSession } = createCoordinator({
      llm,
      emit: (event) => eventTypes.push(event.type),
    });
    const session = createSession();

    await expect(
      coordinator.run({ session, turn, turnStartIndex: -1, ephemeralInput: null }),
    ).resolves.toEqual({ finalAssistantText: 'done' });

    expect(eventTypes).toEqual([
      'llm-turn-start',
      'llm-turn-complete',
      'session-updated',
      'llm-turn-start',
      'llm-turn-complete',
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(saveSession).toHaveBeenCalledTimes(1);
    expect(conversations[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'message', role: 'assistant', content: 'working' }),
        expect.objectContaining({ kind: 'function_call_output', callId: 'call-1' }),
      ]),
    );
  });

  it('checks abort after a late provider result and before executing its tool calls', async () => {
    const abortController = new AbortController();
    const llm: LlmClient = {
      async runTurn() {
        return {
          assistantMessage: 'late result',
          toolCalls: [{ id: 'late-call', name: 'timer', args: { seconds: 1, label: 'late' } }],
        };
      },
    };
    const { coordinator, execute } = createCoordinator({
      llm,
      emit: (event) => {
        if (event.type === 'llm-turn-complete') abortController.abort();
      },
    });

    await expect(
      coordinator.run({
        session: createSession(),
        turn,
        turnStartIndex: -1,
        ephemeralInput: null,
        abortSignal: abortController.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('stops a denied tool batch, records skipped outputs, and performs one tool-free follow-up', async () => {
    const calls: Array<{
      tools: number;
      conversation: LlmConversationItem[];
      message: string;
    }> = [];
    const llm: LlmClient = {
      async runTurn(input) {
        calls.push({
          tools: input.tools.length,
          conversation: [...(input.conversation ?? [])],
          message: input.message,
        });
        if (calls.length === 1) {
          return {
            assistantMessage: '',
            toolCalls: [
              { id: 'denied', name: 'timer', args: { seconds: 1, label: 'one' } },
              { id: 'skipped', name: 'timer', args: { seconds: 1, label: 'two' } },
            ],
          };
        }
        return { assistantMessage: 'explained denial' };
      },
    };
    const execute = vi.fn(async () =>
      JSON.stringify({ error: 'permission denied', _meta: { kind: 'tool-denied' } }),
    );
    const { coordinator } = createCoordinator({ llm, execute });

    await expect(
      coordinator.run({
        session: createSession(),
        turn,
        turnStartIndex: -1,
        ephemeralInput: null,
      }),
    ).resolves.toEqual({ finalAssistantText: 'explained denial' });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.tools).toBe(0);
    expect(calls[1]?.message).toContain('permission denied');
    expect(calls[1]?.conversation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'function_call_output', callId: 'denied' }),
        expect.objectContaining({
          kind: 'function_call_output',
          callId: 'skipped',
          output: expect.stringContaining('Skipped after an earlier tool call was denied.'),
        }),
      ]),
    );
  });
});
