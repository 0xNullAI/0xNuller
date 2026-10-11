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
  toolRegistry?: ToolRegistry;
  getConnectedDeviceKinds?: () => Promise<Set<'coyote'>>;
}) {
  const execute =
    input.execute ??
    vi.fn(async ({ toolCall }: { toolCall: { name: string } }) =>
      JSON.stringify(toolCall.name === 'timer' ? { timer: { id: 'timer-1' } } : { ok: true }),
    );
  const saveSession = vi.fn(async () => undefined);
  const coordinator = new RuntimeTurnCoordinator({
    device: { getState: async () => createEmptyDeviceState() },
    llm: input.llm,
    toolRegistry: input.toolRegistry ?? new ToolRegistry(),
    toolExecutor: {
      execute,
      getConnectedDeviceKinds: input.getConnectedDeviceKinds ?? (async () => new Set()),
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
  it('rejects an unsolicited non-stop tool when this turn was given no tools', async () => {
    const llm: LlmClient = {
      async runTurn(input) {
        expect(input.tools).toEqual([]);
        return {
          assistantMessage: '已经启动设备。',
          toolCalls: [{ id: 'invented-start', name: 'shock_start', args: {} }],
        };
      },
    };
    const { coordinator, execute } = createCoordinator({ llm });
    const result = await coordinator.run({
      session: createSession(),
      turn: {
        text: 'timer follow-up',
        context: { sessionId: 'turn-session', sourceType: 'system', traceId: 'system-turn' },
      },
      turnStartIndex: -1,
      ephemeralInput: null,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(result.receipts[0]?.status).toBe('denied');
    expect(result.status).toBe('incomplete');
    expect(result.finalAssistantText).toContain('未完成请求的操作');
  });

  it('keeps an unsolicited stop reachable while denying later non-stop calls', async () => {
    const llm: LlmClient = {
      async runTurn(input) {
        expect(input.tools).toEqual([]);
        return {
          assistantMessage: '',
          toolCalls: [
            { id: 'start-first', name: 'shock_start', args: {} },
            { id: 'stop-after-denial', name: 'shock_stop', args: {} },
          ],
        };
      },
    };
    const execute = vi.fn(async () => JSON.stringify({ ok: true, command: { type: 'stop' } }));
    const { coordinator } = createCoordinator({ llm, execute });
    const result = await coordinator.run({
      session: createSession(),
      turn: {
        text: 'image-only turn',
        context: { sessionId: 'turn-session', sourceType: 'system', traceId: 'system-turn' },
      },
      turnStartIndex: -1,
      ephemeralInput: null,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(result.receipts.map((receipt) => receipt.status)).toEqual(['denied', 'succeeded']);
    expect(result.status).toBe('incomplete');
  });

  it('replaces an unsupported completion claim before returning the persistent reply', async () => {
    const llm: LlmClient = { runTurn: async () => ({ assistantMessage: '已经启动设备。' }) };
    const { coordinator, execute } = createCoordinator({ llm });
    const result = await coordinator.run({
      session: createSession(),
      turn,
      turnStartIndex: -1,
      ephemeralInput: null,
    });
    expect(result.finalAssistantText).toContain('不能确认“启动设备”已完成');
    expect(result.status).toBe('incomplete');
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not display a fabricated tool call in the shared chat reply', async () => {
    const visible: string[] = [];
    const llm: LlmClient = {
      async runTurn(input) {
        input.onTextDelta?.('我已经调用工具处理了。');
        return { assistantMessage: '我已经调用工具处理了。' };
      },
    };
    const { coordinator, execute } = createCoordinator({
      llm,
      emit: (event) => {
        if (event.type === 'assistant-message-delta') visible.push(event.content);
      },
    });
    const result = await coordinator.run({
      session: createSession(),
      turn,
      turnStartIndex: -1,
      ephemeralInput: null,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(result.finalAssistantText).toContain('不能确认“调用工具”已完成');
    expect(visible).toEqual([result.finalAssistantText]);
  });

  it('does not display or speak a streamed completion claim before evidence is checked', async () => {
    const visible: string[] = [];
    const llm: LlmClient = {
      async runTurn(input) {
        input.onTextDelta?.('已经启动设备。');
        expect(visible).toEqual([]);
        return { assistantMessage: '已经启动设备。' };
      },
    };
    const { coordinator } = createCoordinator({
      llm,
      emit: (event) => {
        if (event.type === 'assistant-message-delta') visible.push(event.content);
      },
    });
    const result = await coordinator.run({
      session: createSession(),
      turn,
      turnStartIndex: -1,
      ephemeralInput: null,
    });
    expect(result.finalAssistantText).toContain('不能确认“启动设备”已完成');
    expect(visible).toEqual([result.finalAssistantText]);
  });

  it('withholds streamed tool-call prose and shows only the checked final iteration', async () => {
    const visible: string[] = [];
    let iteration = 0;
    const llm: LlmClient = {
      async runTurn(input) {
        iteration += 1;
        if (iteration === 1) {
          input.onTextDelta?.('已经启动设备。');
          expect(visible).toEqual([]);
          return {
            assistantMessage: '已经启动设备。',
            toolCalls: [{ id: 'call', name: 'shock_start', args: {} }],
          };
        }
        input.onTextDelta?.('已经启动设备。');
        expect(visible).toEqual([]);
        return { assistantMessage: '已经启动设备。' };
      },
    };
    const execute = vi.fn(async () =>
      JSON.stringify({ error: 'not connected', _meta: { kind: 'tool-denied' } }),
    );
    const { coordinator } = createCoordinator({
      llm,
      execute,
      emit: (event) => {
        if (event.type === 'assistant-message-delta') visible.push(event.content);
      },
    });
    const result = await coordinator.run({
      session: createSession(),
      turn,
      turnStartIndex: -1,
      ephemeralInput: null,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(result.finalAssistantText).toContain('被拒绝');
    expect(visible).toEqual([result.finalAssistantText]);
  });

  it('does not persist a premature completion claim attached to a tool request', async () => {
    let iteration = 0;
    const llm: LlmClient = {
      runTurn: async () =>
        ++iteration === 1
          ? {
              assistantMessage: '已经启动设备。',
              toolCalls: [{ id: 'call', name: 'shock_start', args: {} }],
            }
          : { assistantMessage: '现在可以继续聊天。' },
    };
    const { coordinator } = createCoordinator({ llm });
    const session = createSession();
    await coordinator.run({ session, turn, turnStartIndex: -1, ephemeralInput: null });
    expect(session.messages.some((message) => message.content === '已经启动设备。')).toBe(false);
    expect(session.messages).toEqual([]);
  });

  it('never asks the model to explain a denied tool result', async () => {
    let iteration = 0;
    const runIds: Array<string | undefined> = [];
    const llm: LlmClient = {
      runTurn: async (input) => {
        runIds.push(input.runId);
        return ++iteration === 1
          ? { assistantMessage: '', toolCalls: [{ id: 'call', name: 'timer', args: {} }] }
          : { assistantMessage: '已经设置计时器。' };
      },
    };
    const execute = vi.fn(async () =>
      JSON.stringify({ error: 'permission denied', _meta: { kind: 'tool-denied' } }),
    );
    const { coordinator } = createCoordinator({ llm, execute });
    const result = await coordinator.run({
      session: createSession(),
      turn,
      turnStartIndex: -1,
      ephemeralInput: null,
      runId: 'server-run-denied',
    });
    expect(result.finalAssistantText).toContain('被拒绝');
    expect(runIds).toEqual(['server-run-denied']);
  });

  it('preserves model/session event order across a tool iteration and final reply', async () => {
    const conversations: LlmConversationItem[][] = [];
    const runIds: Array<string | undefined> = [];
    const llm: LlmClient = {
      async runTurn(input) {
        runIds.push(input.runId);
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
    ).resolves.toMatchObject({
      finalAssistantText: 'done',
      runId: 'trace-turn',
      status: 'completed',
    });

    expect(eventTypes).toEqual([
      'llm-turn-start',
      'llm-turn-complete',
      'session-updated',
      'llm-turn-start',
      'llm-turn-complete',
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(runIds).toEqual([undefined, undefined]);
    expect(saveSession).toHaveBeenCalledTimes(1);
    expect(conversations[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'message', role: 'assistant', content: 'working' }),
        expect.objectContaining({ kind: 'function_call_output', callId: 'call-1' }),
      ]),
    );
  });

  it('groups every model step under a supplied server TaskRun without sharing request keys', async () => {
    const runIds: Array<string | undefined> = [];
    const llm: LlmClient = {
      async runTurn(input) {
        runIds.push(input.runId);
        return runIds.length === 1
          ? { assistantMessage: '', toolCalls: [{ id: 'first', name: 'timer', args: {} }] }
          : { assistantMessage: '完成。' };
      },
    };
    const { coordinator } = createCoordinator({ llm });
    const result = await coordinator.run({
      session: createSession(),
      turn,
      turnStartIndex: -1,
      ephemeralInput: null,
      runId: 'server-run-1',
    });
    expect(result.runId).toBe('server-run-1');
    expect(runIds).toEqual(['server-run-1', 'server-run-1']);
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

  it('stops a denied tool batch without another model call', async () => {
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
    ).resolves.toMatchObject({ status: 'incomplete' });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });

  it('keeps confirmed tool failure distinct from an unconfirmed outcome', async () => {
    let iteration = 0;
    const llm: LlmClient = {
      async runTurn() {
        iteration += 1;
        if (iteration === 1)
          return { assistantMessage: '', toolCalls: [{ id: 'failed', name: 'timer', args: {} }] };
        throw new Error('A failed tool must not trigger another model call');
      },
    };
    const execute = vi.fn(async () =>
      JSON.stringify({ error: 'service unavailable', _meta: { kind: 'tool-failed' } }),
    );
    const { coordinator } = createCoordinator({ llm, execute });
    const result = await coordinator.run({
      session: createSession(),
      turn,
      turnStartIndex: -1,
      ephemeralInput: null,
    });
    expect(result.status).toBe('incomplete');
    expect(result.finalAssistantText).toContain('执行失败');
    expect(iteration).toBe(1);
    expect(result.receipts[0]?.status).toBe('failed');
  });

  it.each([JSON.stringify({ error: 'device busy' }), JSON.stringify({ ok: false })])(
    'stops the batch after a failed receipt without a metadata marker: %s',
    async (output) => {
      const llm: LlmClient = {
        runTurn: vi.fn(async () => ({
          assistantMessage: '',
          toolCalls: [
            { id: 'failed', name: 'timer', args: {} },
            { id: 'later', name: 'task_plan_save', args: {} },
          ],
        })),
      };
      const execute = vi.fn(async () => output);
      const { coordinator } = createCoordinator({ llm, execute });
      const result = await coordinator.run({
        session: createSession(),
        turn,
        turnStartIndex: -1,
        ephemeralInput: null,
      });
      expect(execute).toHaveBeenCalledOnce();
      expect(result.receipts[0]?.status).toBe('failed');
      expect(result.finalAssistantText).toContain('执行失败');
      expect(result.status).toBe('incomplete');
      expect(llm.runTurn).toHaveBeenCalledOnce();
    },
  );

  it('still executes an explicit stop after a denied tool', async () => {
    const llm: LlmClient = {
      runTurn: vi.fn(async () => ({
        assistantMessage: '',
        toolCalls: [
          { id: 'denied', name: 'timer', args: {} },
          { id: 'stop', name: 'shock_stop', args: {} },
          { id: 'skipped', name: 'timer', args: {} },
        ],
      })),
    };
    const execute = vi.fn(async ({ toolCall }: { toolCall: { name: string } }) =>
      toolCall.name === 'shock_stop'
        ? JSON.stringify({ ok: true, command: { type: 'stop' } })
        : JSON.stringify({ error: 'permission denied', _meta: { kind: 'tool-denied' } }),
    );
    const { coordinator } = createCoordinator({ llm, execute });
    const result = await coordinator.run({
      session: createSession(),
      turn,
      turnStartIndex: -1,
      ephemeralInput: null,
    });
    expect(execute.mock.calls.map(([input]) => input.toolCall.name)).toEqual([
      'timer',
      'shock_stop',
    ]);
    expect(result.status).toBe('incomplete');
    expect(result.finalAssistantText).toContain('被拒绝');
    expect(llm.runTurn).toHaveBeenCalledTimes(1);
  });

  it.each(['stop', 'device_stop', 'device_emergency_stop'])(
    'keeps %s reachable after an earlier denied tool',
    async (stopName) => {
      const llm: LlmClient = {
        runTurn: vi.fn(async () => ({
          assistantMessage: '',
          toolCalls: [
            { id: 'denied', name: 'timer', args: {} },
            { id: 'stop', name: stopName, args: {} },
            { id: 'skipped', name: 'task_plan_save', args: {} },
          ],
        })),
      };
      const execute = vi.fn(async ({ toolCall }: { toolCall: { name: string } }) =>
        toolCall.name === stopName
          ? JSON.stringify({ ok: true, command: { type: 'stop' } })
          : JSON.stringify({ error: 'permission denied', _meta: { kind: 'tool-denied' } }),
      );
      const { coordinator } = createCoordinator({ llm, execute });
      const result = await coordinator.run({
        session: createSession(),
        turn,
        turnStartIndex: -1,
        ephemeralInput: null,
      });
      expect(execute.mock.calls.map(([input]) => input.toolCall.name)).toEqual(['timer', stopName]);
      expect(result.status).toBe('incomplete');
      expect(llm.runTurn).toHaveBeenCalledOnce();
    },
  );

  it('stops a batch after an unconfirmed write and keeps the run in needs-review', async () => {
    const llm: LlmClient = {
      runTurn: vi.fn(async () => ({
        assistantMessage: '',
        toolCalls: [
          { id: 'write', name: 'task_plan_save', args: {} },
          { id: 'next', name: 'timer', args: {} },
        ],
      })),
    };
    const execute = vi.fn(async () =>
      JSON.stringify({ error: '结果未确认', _meta: { kind: 'tool-unknown' } }),
    );
    const { coordinator } = createCoordinator({ llm, execute });
    const result = await coordinator.run({
      session: createSession(),
      turn,
      turnStartIndex: -1,
      ephemeralInput: null,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(result.receipts).toEqual([
      expect.objectContaining({ runId: 'trace-turn', callId: 'write', status: 'unknown' }),
    ]);
    expect(result.status).toBe('needs-review');
    expect(result.finalAssistantText).toContain('执行状态未确认');
    expect(llm.runTurn).toHaveBeenCalledOnce();
  });

  it('does not dispatch the same model call ID twice across iterations', async () => {
    let iteration = 0;
    const llm: LlmClient = {
      async runTurn() {
        iteration += 1;
        return iteration <= 2
          ? { assistantMessage: '', toolCalls: [{ id: 'same-call', name: 'timer', args: {} }] }
          : { assistantMessage: '后续步骤未执行。' };
      },
    };
    const { coordinator, execute } = createCoordinator({ llm });
    const recorded: string[] = [];
    const result = await coordinator.run({
      session: createSession(),
      turn,
      turnStartIndex: -1,
      ephemeralInput: null,
      hooks: { onToolReceipt: (receipt) => recorded.push(receipt.callId) },
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(recorded).toEqual(['same-call']);
    expect(result.receipts).toHaveLength(1);
    expect(result.status).toBe('incomplete');
  });

  it('still executes a stop whose provider call ID is missing or reused', async () => {
    let iteration = 0;
    const llm: LlmClient = {
      async runTurn() {
        iteration += 1;
        if (iteration === 1)
          return { assistantMessage: '', toolCalls: [{ id: 'call_0', name: 'timer', args: {} }] };
        if (iteration === 2)
          return {
            assistantMessage: '',
            toolCalls: [
              { id: '', name: 'shock_stop', args: {} },
              { id: 'call_0', name: 'vibrate_stop', args: {} },
              { id: '', name: 'timer', args: {} },
            ],
          };
        return { assistantMessage: '好的。' };
      },
    };
    const { coordinator, execute } = createCoordinator({ llm });
    const result = await coordinator.run({
      session: createSession(),
      turn,
      turnStartIndex: -1,
      ephemeralInput: null,
    });
    const executed = execute.mock.calls.map(([input]) => input.toolCall);
    expect(executed.map((call) => call.name)).toEqual(['timer', 'shock_stop', 'vibrate_stop']);
    const stopIds = executed.slice(1).map((call) => call.id);
    expect(stopIds.every((id) => id.startsWith('stop-'))).toBe(true);
    expect(new Set(stopIds).size).toBe(2);
    expect(result.receipts.filter((receipt) => receipt.name.endsWith('_stop'))).toHaveLength(2);
  });

  it('fails a non-stop tool closed when the durable claim fails before dispatch', async () => {
    const llm: LlmClient = {
      runTurn: vi
        .fn()
        .mockResolvedValueOnce({
          assistantMessage: '',
          toolCalls: [{ id: 'write', name: 'task_plan_save', args: {} }],
        })
        .mockResolvedValueOnce({ assistantMessage: '计划没有保存。' }),
    };
    const { coordinator, execute } = createCoordinator({ llm });
    const recordToolReceipt = vi.fn(async () => undefined);
    const result = await coordinator.run({
      session: createSession(),
      turn,
      turnStartIndex: -1,
      ephemeralInput: null,
      hooks: {
        beforeToolCall: async () => {
          throw new Error('server unavailable');
        },
        recordToolReceipt,
      },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(recordToolReceipt).not.toHaveBeenCalled();
    expect(result.receipts[0]?.status).toBe('denied');
    expect(result.status).toBe('incomplete');
  });

  it.each(['shock_stop', 'stop', 'device_stop', 'device_emergency_stop'])(
    'keeps %s reachable but unverified if the reporter fails',
    async (stopName) => {
      const llm: LlmClient = {
        runTurn: vi
          .fn()
          .mockResolvedValueOnce({
            assistantMessage: '',
            toolCalls: [{ id: 'stop-call', name: stopName, args: {} }],
          })
          .mockResolvedValueOnce({ assistantMessage: '已经停止设备。' }),
      };
      const execute = vi.fn(async () => JSON.stringify({ ok: true, command: { type: 'stop' } }));
      const { coordinator } = createCoordinator({ llm, execute });
      const result = await coordinator.run({
        session: createSession(),
        turn,
        turnStartIndex: -1,
        ephemeralInput: null,
        hooks: {
          beforeToolCall: async () => {
            throw new Error('server unavailable');
          },
          recordToolReceipt: async () => {
            throw new Error('not claimed');
          },
        },
      });
      expect(execute).toHaveBeenCalledOnce();
      expect(result.receipts[0]?.status).toBe('unknown');
      expect(result.status).toBe('needs-review');
      expect(result.finalAssistantText).toContain('不能确认“停止设备”已完成');
      expect(llm.runTurn).toHaveBeenCalledOnce();
    },
  );

  it('downgrades a committed write when the receipt acknowledgement is lost', async () => {
    const llm: LlmClient = {
      runTurn: vi
        .fn()
        .mockResolvedValueOnce({
          assistantMessage: '',
          toolCalls: [
            { id: 'write', name: 'task_plan_save', args: {} },
            { id: 'next', name: 'timer', args: {} },
          ],
        })
        .mockResolvedValueOnce({ assistantMessage: '计划已经保存。' }),
    };
    const execute = vi.fn(async () => JSON.stringify({ item: { id: 'plan-1' } }));
    const { coordinator } = createCoordinator({ llm, execute });
    const result = await coordinator.run({
      session: createSession(),
      turn,
      turnStartIndex: -1,
      ephemeralInput: null,
      hooks: {
        beforeToolCall: async () => undefined,
        recordToolReceipt: async () => {
          throw new Error('response lost');
        },
      },
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(result.receipts[0]?.status).toBe('unknown');
    expect(result.status).toBe('needs-review');
    expect(result.finalAssistantText).toContain('执行状态未确认');
    expect(llm.runTurn).toHaveBeenCalledOnce();
  });

  it('does not let an unverified successful-looking device response trigger another tool or model claim', async () => {
    const llm: LlmClient = {
      runTurn: vi.fn(async () => ({
        assistantMessage: 'I have started the device.',
        toolCalls: [
          { id: 'device', name: 'shock_start', args: {} },
          { id: 'next', name: 'timer', args: {} },
        ],
      })),
    };
    const execute = vi.fn(async () => JSON.stringify({ ok: true }));
    const { coordinator } = createCoordinator({ llm, execute });
    const result = await coordinator.run({
      session: createSession(),
      turn,
      turnStartIndex: -1,
      ephemeralInput: null,
    });
    expect(result.status).toBe('needs-review');
    expect(result.receipts[0]?.status).toBe('unknown');
    expect(result.finalAssistantText).toContain('执行状态未确认');
    expect(result.finalAssistantText).not.toContain('started');
    expect(execute).toHaveBeenCalledOnce();
    expect(llm.runTurn).toHaveBeenCalledOnce();
  });

  it('stops the batch when an indicator receipt belongs to a different device', async () => {
    const llm: LlmClient = {
      runTurn: vi.fn(async () => ({
        assistantMessage: '已经设置指示灯颜色。',
        toolCalls: [
          {
            id: 'indicator',
            name: 'set_indicator_color',
            args: { deviceKind: 'paw-prints', color: 7 },
          },
          { id: 'next', name: 'timer', args: {} },
        ],
      })),
    };
    const execute = vi.fn(async () =>
      JSON.stringify({ ok: true, deviceKind: 'opossum', color: 7 }),
    );
    const { coordinator } = createCoordinator({ llm, execute });
    const result = await coordinator.run({
      session: createSession(),
      turn,
      turnStartIndex: -1,
      ephemeralInput: null,
    });
    expect(result.receipts[0]?.status).toBe('unknown');
    expect(result.status).toBe('needs-review');
    expect(result.finalAssistantText).toContain('执行状态未确认');
    expect(execute).toHaveBeenCalledOnce();
    expect(llm.runTurn).toHaveBeenCalledOnce();
  });

  it('pauses a tool batch when the owner says the operation is pending', async () => {
    const llm: LlmClient = {
      runTurn: vi.fn(async () => ({
        assistantMessage: '',
        toolCalls: [
          { id: 'pending', name: 'task_plan_save', args: {} },
          { id: 'next', name: 'timer', args: {} },
        ],
      })),
    };
    const execute = vi.fn(async () =>
      JSON.stringify({ status: 'pending', item: { id: 'plan-1' } }),
    );
    const { coordinator } = createCoordinator({ llm, execute });
    const result = await coordinator.run({
      session: createSession(),
      turn,
      turnStartIndex: -1,
      ephemeralInput: null,
    });
    expect(result.status).toBe('incomplete');
    expect(result.receipts[0]?.status).toBe('pending');
    expect(result.finalAssistantText).toContain('仍在处理中');
    expect(execute).toHaveBeenCalledOnce();
    expect(llm.runTurn).toHaveBeenCalledOnce();
  });

  it('keeps an explicit stop reachable after an earlier outcome becomes unconfirmed', async () => {
    const llm: LlmClient = {
      runTurn: vi.fn(async () => ({
        assistantMessage: '',
        toolCalls: [
          { id: 'write', name: 'task_plan_save', args: {} },
          { id: 'skipped', name: 'timer', args: {} },
          { id: 'stop', name: 'shock_stop', args: {} },
        ],
      })),
    };
    const execute = vi.fn(async ({ toolCall }: { toolCall: { name: string } }) =>
      toolCall.name === 'shock_stop'
        ? JSON.stringify({ ok: true, command: { type: 'stop' } })
        : JSON.stringify({ error: '结果未确认', _meta: { kind: 'tool-unknown' } }),
    );
    const { coordinator } = createCoordinator({ llm, execute });
    const result = await coordinator.run({
      session: createSession(),
      turn,
      turnStartIndex: -1,
      ephemeralInput: null,
    });
    expect(execute.mock.calls.map(([input]) => input.toolCall.name)).toEqual([
      'task_plan_save',
      'shock_stop',
    ]);
    expect(result.receipts.map((receipt) => [receipt.name, receipt.status])).toEqual([
      ['task_plan_save', 'unknown'],
      ['shock_stop', 'succeeded'],
    ]);
    expect(result.status).toBe('needs-review');
    expect(llm.runTurn).toHaveBeenCalledOnce();
  });

  it('gives one tool-free bounded follow-up after the last permitted tool iteration', async () => {
    let iteration = 0;
    const llm: LlmClient = {
      async runTurn(input) {
        iteration += 1;
        if (iteration <= 3) {
          expect(input.tools.length).toBeGreaterThan(0);
          return {
            assistantMessage: '',
            toolCalls: [{ id: `timer-${iteration}`, name: 'timer', args: {} }],
          };
        }
        expect(input.tools).toEqual([]);
        return { assistantMessage: '已设置计时器，本轮还有步骤未完成。' };
      },
    };
    const registry = new ToolRegistry();
    registry.register({
      name: 'timer',
      definition: {
        name: 'timer',
        description: 'timer',
        parameters: { type: 'object', properties: {} },
      },
      toExecutionPlan: () => ({ type: 'inline', output: '{}' }),
    });
    const { coordinator, execute } = createCoordinator({ llm, toolRegistry: registry });
    const result = await coordinator.run({
      session: createSession(),
      turn,
      turnStartIndex: -1,
      ephemeralInput: null,
    });
    expect(iteration).toBe(4);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(result.status).toBe('incomplete');
    expect(result.receipts).toHaveLength(3);
    expect(result.finalAssistantText).toContain('已设置计时器');
  });

  it('removes a disconnected device tool from the very next model request', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'shock_stop',
      definition: {
        name: 'shock_stop',
        description: 'stop connected Coyote',
        parameters: { type: 'object', properties: {} },
      },
      toExecutionPlan: () => ({ type: 'inline', output: 'stopped' }),
    });
    registry.register({
      name: 'timer',
      definition: {
        name: 'timer',
        description: 'device-independent timer',
        parameters: { type: 'object', properties: {} },
      },
      toExecutionPlan: () => ({ type: 'inline', output: 'timer set' }),
    });

    let connected = true;
    const requests: string[][] = [];
    const llm: LlmClient = {
      async runTurn(input) {
        requests.push(input.tools.map((tool) => tool.name));
        return requests.length === 1
          ? {
              assistantMessage: '',
              toolCalls: [{ id: 'timer-call', name: 'timer', args: {} }],
            }
          : { assistantMessage: 'done' };
      },
    };
    const execute = vi.fn(async () => {
      connected = false;
      return JSON.stringify({ timer: { id: 'timer-1' } });
    });
    const { coordinator } = createCoordinator({
      llm,
      execute,
      toolRegistry: registry,
      getConnectedDeviceKinds: async () => new Set(connected ? ['coyote'] : []),
    });

    await coordinator.run({
      session: createSession(),
      turn,
      turnStartIndex: -1,
      ephemeralInput: null,
    });

    expect(requests).toEqual([['shock_stop', 'timer'], ['timer']]);
  });
});
