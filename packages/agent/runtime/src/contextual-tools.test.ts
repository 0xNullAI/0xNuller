import { expect, it, vi } from 'vitest';
import { AgentRuntime } from './agent-runtime.js';
import { TestDevice } from './runtime.test-support.js';
import type { ContextualTools } from './contextual-tools.js';
it('passes exact session/context through the permission and execution path', async () => {
  const order: string[] = [];
  let turns = 0;
  const resolve = vi.fn(async () => {
    order.push('resolve');
    return { type: 'inline' as const, output: '{"saved":true}' };
  });
  const tools: ContextualTools = {
    permissionRequiredToolNames: new Set(['task_plan_save']),
    displayNames: { task_plan_save: '保存任务计划' },
    listDefinitions: async () => [
      {
        name: 'task_plan_save',
        description: 'plan',
        parameters: { type: 'object', properties: {} },
      },
    ],
    resolve,
  };
  const runtime = new AgentRuntime({
    device: new TestDevice({ connected: false }),
    permission: {
      request: async () => {
        order.push('permission');
        return { type: 'approve-once' };
      },
    },
    contextualTools: tools,
    llm: {
      runTurn: async (input) => {
        expect(input.tools.some((tool) => tool.name === 'task_plan_save')).toBe(true);
        return turns++ === 0
          ? { assistantMessage: '', toolCalls: [{ id: 'call', name: 'task_plan_save', args: {} }] }
          : { assistantMessage: 'saved' };
      },
    },
  });
  await runtime.sendUserMessage({
    sessionId: 'owned',
    text: 'plan',
    context: { sessionId: 'owned', sourceType: 'web', traceId: 'trace' },
  });
  expect(order).toEqual(['permission', 'resolve']);
  expect(resolve).toHaveBeenCalledWith(
    expect.objectContaining({
      session: expect.objectContaining({ id: 'owned' }),
      context: expect.objectContaining({ sessionId: 'owned' }),
    }),
  );
  runtime.dispose();
});
it('does not run contextual writes after permission denial', async () => {
  let turns = 0;
  const resolve = vi.fn();
  const runtime = new AgentRuntime({
    device: new TestDevice({ connected: false }),
    permission: { request: async () => ({ type: 'deny', reason: 'no' }) },
    contextualTools: {
      permissionRequiredToolNames: new Set(['task_plan_save']),
      displayNames: {},
      listDefinitions: async () => [],
      resolve,
    },
    llm: {
      runTurn: async () =>
        turns++ === 0
          ? { assistantMessage: '', toolCalls: [{ id: 'call', name: 'task_plan_save', args: {} }] }
          : { assistantMessage: 'denied' },
    },
  });
  await runtime.sendUserMessage({
    sessionId: 's',
    text: 'plan',
    context: { sessionId: 's', sourceType: 'web', traceId: 'trace' },
  });
  expect(resolve).not.toHaveBeenCalled();
  runtime.dispose();
});
