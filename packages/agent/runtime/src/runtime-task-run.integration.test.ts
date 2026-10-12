import { describe, expect, it, vi } from 'vitest';
import type { LlmClient } from '@dg-agent/core';
import { AgentRuntime } from './agent-runtime.js';
import type { RuntimeTaskRunReporter } from './runtime-task-run.js';
import { TestDevice, TestPermission } from './runtime.test-support.js';

function reporter(): RuntimeTaskRunReporter {
  return {
    begin: vi.fn(async () => undefined),
    beforeToolCall: vi.fn(async () => undefined),
    recordReceipt: vi.fn(async () => undefined),
    finish: vi.fn(async () => undefined),
  };
}

describe('AgentRuntime TaskRun boundary', () => {
  it('retains an unconfirmed in-flight call when a reply is cancelled', async () => {
    let releaseResolve!: () => void;
    let signalResolveStarted!: () => void;
    const resolveStarted = new Promise<void>((resolve) => (signalResolveStarted = resolve));
    const release = new Promise<void>((resolve) => (releaseResolve = resolve));
    const taskRunReporter = reporter();
    const llm: LlmClient = {
      runTurn: async () => ({
        assistantMessage: '',
        toolCalls: [{ id: 'write-1', name: 'task_plan_save', args: {} }],
      }),
    };
    const runtime = new AgentRuntime({
      device: new TestDevice({ connected: false }),
      llm,
      permission: new TestPermission(),
      taskRunReporter,
      contextualTools: {
        permissionRequiredToolNames: new Set(),
        displayNames: {},
        listDefinitions: async () => [
          { name: 'task_plan_save', description: 'save', parameters: { type: 'object' } },
        ],
        resolve: async () => {
          signalResolveStarted();
          await release;
          return { type: 'inline', output: JSON.stringify({ item: { id: 'saved' } }) };
        },
      },
    });
    const send = runtime.sendUserMessage({
      sessionId: 'chat',
      runId: 'server-run-1',
      text: '保存计划',
      context: { sessionId: 'chat', sourceType: 'web', traceId: 'request-1' },
    });
    await resolveStarted;
    await runtime.abortCurrentReply('chat');
    releaseResolve();
    await expect(send).rejects.toThrow('已停止');

    const snapshot = runtime.getTaskRun('server-run-1');
    expect(snapshot).toMatchObject({ status: 'needs-review', provenance: 'client-reported' });
    expect(snapshot?.receipts).toEqual([
      expect.objectContaining({ callId: 'write-1', status: 'unknown' }),
    ]);
    expect(taskRunReporter.finish).toHaveBeenCalledWith({
      runId: 'server-run-1',
      sessionId: 'chat',
      status: 'needs-review',
    });
    expect(taskRunReporter.recordReceipt).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('does not start the model when the server run cannot be acknowledged', async () => {
    const taskRunReporter = reporter();
    taskRunReporter.begin = vi.fn(async () => {
      throw new Error('server unavailable');
    });
    const llm: LlmClient = { runTurn: vi.fn(async () => ({ assistantMessage: 'done' })) };
    const runtime = new AgentRuntime({
      device: new TestDevice({ connected: false }),
      llm,
      permission: new TestPermission(),
      taskRunReporter,
    });
    const input = {
      sessionId: 'chat',
      runId: 'server-run-1',
      text: 'hello',
      context: { sessionId: 'chat', sourceType: 'web' as const, traceId: 'request-1' },
    };
    await runtime.sendUserMessage(input);
    expect(llm.runTurn).not.toHaveBeenCalled();
    expect(runtime.getTaskRun('server-run-1')?.status).toBe('failed');
    const messages = (await runtime.getSessionSnapshot('chat')).messages;
    await expect(runtime.sendUserMessage(input)).rejects.toThrow('任务编号重复');
    expect((await runtime.getSessionSnapshot('chat')).messages).toEqual(messages);
    runtime.dispose();
  });

  it('lets internal no-run messages reply without advertising tools or reporting a false server run', async () => {
    const taskRunReporter = reporter();
    const llm: LlmClient = {
      runTurn: vi.fn(async (input) => {
        expect(input.tools).toEqual([]);
        return { assistantMessage: '收到传感器信号。' };
      }),
    };
    const runtime = new AgentRuntime({
      device: new TestDevice({ connected: false }),
      llm,
      permission: new TestPermission(),
      taskRunReporter,
    });
    await runtime.sendUserMessage({
      sessionId: 'sensor-chat',
      text: 'sensor event',
      context: { sessionId: 'sensor-chat', sourceType: 'sensor', traceId: 'event-1' },
      persistMessage: false,
    });
    expect(llm.runTurn).toHaveBeenCalledOnce();
    expect(taskRunReporter.begin).not.toHaveBeenCalled();
    expect(runtime.listTaskRuns('sensor-chat')[0]?.status).toBe('completed');
    runtime.dispose();
  });

  it('does not block a real stop command when the server claim is unavailable', async () => {
    const taskRunReporter = reporter();
    taskRunReporter.beforeToolCall = vi.fn(async () => {
      throw new Error('server unavailable');
    });
    const device = new TestDevice({ connected: true });
    const execute = vi.spyOn(device, 'execute');
    let iteration = 0;
    const llm: LlmClient = {
      runTurn: async () =>
        ++iteration === 1
          ? {
              assistantMessage: '',
              toolCalls: [{ id: 'stop-1', name: 'shock_stop', args: {} }],
            }
          : { assistantMessage: '已经停止设备。' },
    };
    const runtime = new AgentRuntime({
      device,
      llm,
      permission: new TestPermission(),
      taskRunReporter,
    });
    await runtime.sendUserMessage({
      sessionId: 'chat',
      runId: 'server-run-stop',
      text: '停止设备',
      context: { sessionId: 'chat', sourceType: 'web', traceId: 'request-stop' },
    });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ type: 'stop' }));
    expect(runtime.getTaskRun('server-run-stop')?.status).toBe('needs-review');
    expect(runtime.getTaskRun('server-run-stop')?.receipts[0]?.status).toBe('unknown');
    expect((await runtime.getSessionSnapshot('chat')).messages.at(-1)?.content).toContain(
      '不能确认“停止设备”已完成',
    );
    runtime.dispose();
  });

  it('still executes a stop when an Agent UI event listener throws', async () => {
    const device = new TestDevice({ connected: true });
    const execute = vi.spyOn(device, 'execute');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let iteration = 0;
    const runtime = new AgentRuntime({
      device,
      llm: {
        runTurn: async () =>
          ++iteration === 1
            ? { assistantMessage: '', toolCalls: [{ id: 'stop-1', name: 'shock_stop', args: {} }] }
            : { assistantMessage: '已停止设备。' },
      },
      permission: new TestPermission(),
    });
    runtime.subscribe(() => {
      throw new Error('UI listener failed');
    });
    try {
      await runtime.sendUserMessage({
        sessionId: 'chat',
        text: '停止设备',
        context: { sessionId: 'chat', sourceType: 'cli', traceId: 'stop-observer-failure' },
      });
      expect(execute).toHaveBeenCalledWith(expect.objectContaining({ type: 'stop' }));
      expect(log).toHaveBeenCalled();
    } finally {
      runtime.dispose();
      log.mockRestore();
    }
  });
});
