import { describe, expect, it, vi } from 'vitest';
import { createEmptyDeviceState, type DeviceKind, type ToolDefinition } from '@dg-agent/core';
import { resolveToolCallConfig } from './tool-call-config.js';
import { createTurnState } from './runtime-turn-state.js';
import { filterToolDefinitionsByConnectedDevices } from './device-tool-availability.js';
import { RuntimeToolExecutor, type RuntimeToolExecutorOptions } from './runtime-tool-executor.js';

function def(
  name: string,
  parameters: ToolDefinition['parameters'] = { type: 'object', properties: {} },
): ToolDefinition {
  return { name, description: name, parameters };
}

// Mirrors what the real registry advertises post-1.9.0: shock_* only (the
// pre-rename names survive as invisible aliases, not listed definitions).
const ALL_DEFINITIONS: ToolDefinition[] = [
  def('shock_start'),
  def('shock_stop'),
  def('shock_adjust'),
  def('shock_change_wave'),
  def('shock_burst'),
  def('vibrate_start'),
  def('vibrate_stop'),
  def('vibrate_adjust'),
  def('set_indicator_color', {
    type: 'object',
    properties: {
      deviceKind: { type: 'string', enum: ['paw-prints', 'civet-edging', 'opossum'] },
      color: { type: 'integer' },
    },
  }),
  def('timer'),
  def('design_wave'),
];

function names(definitions: ToolDefinition[]): string[] {
  return definitions.map((d) => d.name);
}

describe('filterToolDefinitionsByConnectedDevices', () => {
  it('drops every device tool when nothing is connected, but keeps device-less tools', () => {
    const result = filterToolDefinitionsByConnectedDevices(ALL_DEFINITIONS, new Set());
    expect(names(result)).toEqual(['timer', 'design_wave']);
  });

  it('includes Coyote tools only when coyote is connected', () => {
    const connected = new Set<DeviceKind>(['coyote']);
    const result = filterToolDefinitionsByConnectedDevices(ALL_DEFINITIONS, connected);
    expect(names(result)).toEqual(
      expect.arrayContaining([
        'shock_start',
        'shock_stop',
        'shock_adjust',
        'shock_change_wave',
        'shock_burst',
      ]),
    );
    expect(names(result)).not.toEqual(expect.arrayContaining(['vibrate_start']));
  });

  it('includes vibrate_* tools only when opossum is connected', () => {
    const connected = new Set<DeviceKind>(['opossum']);
    const result = filterToolDefinitionsByConnectedDevices(ALL_DEFINITIONS, connected);
    expect(names(result)).toEqual(
      expect.arrayContaining(['vibrate_start', 'vibrate_stop', 'vibrate_adjust']),
    );
    expect(names(result)).not.toEqual(expect.arrayContaining(['shock_start']));
  });

  it('drops set_indicator_color entirely when no LED-capable device is connected', () => {
    const connected = new Set<DeviceKind>(['coyote']); // coyote has no LED
    const result = filterToolDefinitionsByConnectedDevices(ALL_DEFINITIONS, connected);
    expect(names(result)).not.toEqual(expect.arrayContaining(['set_indicator_color']));
  });

  it("narrows set_indicator_color's deviceKind enum to only the connected LED-capable kinds", () => {
    const connected = new Set<DeviceKind>(['opossum', 'coyote']);
    const result = filterToolDefinitionsByConnectedDevices(ALL_DEFINITIONS, connected);
    const tool = result.find((d) => d.name === 'set_indicator_color');
    expect(tool).toBeDefined();
    const properties = (tool!.parameters as { properties: { deviceKind: { enum: string[] } } })
      .properties;
    expect(properties.deviceKind.enum).toEqual(['opossum']);
  });

  it('always keeps tools that need no device, regardless of connection state', () => {
    const result = filterToolDefinitionsByConnectedDevices(ALL_DEFINITIONS, new Set());
    expect(names(result)).toEqual(expect.arrayContaining(['timer', 'design_wave']));
  });

  it('keeps every device tool when every device kind is connected', () => {
    const connected = new Set<DeviceKind>(['coyote', 'opossum', 'paw-prints', 'civet-edging']);
    const result = filterToolDefinitionsByConnectedDevices(ALL_DEFINITIONS, connected);
    expect(names(result)).toEqual(names(ALL_DEFINITIONS));
  });
});

describe('RuntimeToolExecutor timers', () => {
  it('does not arm a timer when the accepted action cannot be recorded', async () => {
    vi.useFakeTimers();
    try {
      const emit = vi.fn();
      const enqueueTimerTrigger = vi.fn();
      const executor = new RuntimeToolExecutor({
        emit,
        enqueueTimerTrigger,
        getSessionGeneration: () => 0,
        traceStore: {
          append: vi.fn(async () => {
            throw new Error('trace unavailable');
          }),
        },
      } as unknown as RuntimeToolExecutorOptions);

      await expect(
        executor['scheduleTimer'](
          {
            id: 'session',
            createdAt: 1,
            updatedAt: 1,
            messages: [],
            deviceState: createEmptyDeviceState(),
          },
          { label: 'water', seconds: 1 },
          { sessionId: 'session', sourceType: 'web', traceId: 'trace' },
          { id: 'call', name: 'timer', args: {} },
        ),
      ).rejects.toThrow('trace unavailable');

      expect(vi.getTimerCount()).toBe(0);
      await vi.runAllTimersAsync();
      expect(enqueueTimerTrigger).not.toHaveBeenCalled();
      expect(emit.mock.calls.map(([event]) => event.type)).toEqual(['tool-call-executing']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps concurrent timers with the same label and due time independently cancellable', async () => {
    vi.useFakeTimers();
    try {
      const enqueueTimerTrigger = vi.fn();
      const executor = new RuntimeToolExecutor({
        emit: vi.fn(),
        enqueueTimerTrigger,
        getSessionGeneration: () => 0,
        traceStore: { append: vi.fn(async () => ({})) },
      } as unknown as RuntimeToolExecutorOptions);
      const session = {
        id: 'session',
        createdAt: 1,
        updatedAt: 1,
        messages: [],
        deviceState: createEmptyDeviceState(),
      };
      const context = { sessionId: 'session', sourceType: 'web' as const, traceId: 'trace' };
      const first = JSON.parse(
        await executor['scheduleTimer'](session, { label: 'water', seconds: 1 }, context, {
          id: 'first',
          name: 'timer',
          args: {},
        }),
      ) as { timer: { id: string } };
      const second = JSON.parse(
        await executor['scheduleTimer'](session, { label: 'water', seconds: 1 }, context, {
          id: 'second',
          name: 'timer',
          args: {},
        }),
      ) as { timer: { id: string } };
      expect(first.timer.id).not.toBe(second.timer.id);
      executor.cancelScheduledTimers('session');
      expect(vi.getTimerCount()).toBe(0);
      await vi.runAllTimersAsync();
      expect(enqueueTimerTrigger).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('RuntimeToolExecutor uncertain outcomes', () => {
  const session = {
    id: 'session',
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    deviceState: { ...createEmptyDeviceState(), connected: true },
  };
  const context = { sessionId: 'session', sourceType: 'web' as const, traceId: 'run-1' };

  it('denies start before dispatch but still attempts stop when proposal trace fails', async () => {
    const queue = { enqueue: vi.fn(async () => ({ state: session.deviceState })) };
    const traceStore = {
      append: vi.fn(async () => {
        throw new Error('trace unavailable');
      }),
    };
    const executor = new RuntimeToolExecutor({
      device: { getState: async () => session.deviceState },
      queue,
      toolRegistry: {
        getDisplayName: () => undefined,
        resolve: async ({ name }: { name: string }) => ({
          type: 'device',
          command: { type: name === 'shock_stop' ? 'stop' : 'start', channel: 'A' },
        }),
      },
      policyEngine: { evaluate: () => ({ type: 'allow' }) },
      toolCallConfig: resolveToolCallConfig(),
      deviceExecutionGate: async () => true,
      emit: vi.fn(),
      logger: { error: vi.fn(), warn: vi.fn() },
      traceStore,
    } as unknown as RuntimeToolExecutorOptions);

    const start = await executor.execute({
      session,
      context,
      turnState: createTurnState(),
      toolCall: { id: 'start-1', name: 'shock_start', args: {} },
    });
    expect(JSON.parse(start)._meta.kind).toBe('tool-denied');
    expect(queue.enqueue).not.toHaveBeenCalled();

    const stop = await executor.execute({
      session,
      context,
      turnState: createTurnState(),
      toolCall: { id: 'stop-1', name: 'shock_stop', args: {} },
    });
    expect(queue.enqueue).toHaveBeenCalledOnce();
    expect(queue.enqueue).toHaveBeenCalledWith(expect.objectContaining({ type: 'stop' }));
    expect(JSON.parse(stop)._meta.kind).toBe('tool-unknown');
  });

  it('does not report an inline write as successful when its trace receipt cannot be saved', async () => {
    const logger = { error: vi.fn() };
    const executor = new RuntimeToolExecutor({
      emit: vi.fn(),
      logger,
      traceStore: {
        append: vi.fn(async () => {
          throw new Error('trace unavailable');
        }),
      },
    } as unknown as RuntimeToolExecutorOptions);
    const output = await executor['recordInlineResult']({
      session,
      context,
      toolCall: { id: 'call-1', name: 'task_plan_save', args: {} },
      plan: { type: 'inline', output: JSON.stringify({ item: { id: 'plan-1' } }) },
    });
    expect(JSON.parse(output)._meta).toMatchObject({ kind: 'tool-unknown', toolCallId: 'call-1' });
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it('treats a timed-out owner response as unknown because its write may have committed', async () => {
    const emit = vi.fn();
    const traceStore = { append: vi.fn(async () => ({})) };
    const executor = new RuntimeToolExecutor({
      emit,
      logger: { error: vi.fn() },
      traceStore,
      toolCallConfig: resolveToolCallConfig(),
      toolRegistry: { getDisplayName: () => undefined },
      contextualTools: {
        displayNames: {},
        permissionRequiredToolNames: new Set(),
        resolve: async () => {
          throw new Error('request timed out');
        },
      },
    } as unknown as RuntimeToolExecutorOptions);
    const output = await executor.execute({
      session,
      context,
      turnState: {
        workingItems: [],
        totalToolCalls: 0,
        adjustStrengthCalls: 0,
        vibrateAdjustCalls: 0,
        burstCallsByChannel: { A: 0, B: 0 },
        vibrateBurstCallsByChannel: { A: 0, B: 0 },
        narrations: [],
      },
      toolCall: { id: 'save-1', name: 'task_plan_save', args: {} },
    });
    expect(JSON.parse(output)._meta.kind).toBe('tool-unknown');
    expect(traceStore.append).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({
        kind: 'tool-unknown',
        turnId: 'run-1',
        toolCallId: 'save-1',
      }),
    );
    expect(emit.mock.calls.map(([event]) => event.type)).toEqual([
      'tool-call-proposed',
      'runtime-warning',
    ]);
  });

  it('marks a dispatched physical command as unconfirmed if trace persistence fails', async () => {
    const queue = { enqueue: vi.fn(async () => ({ state: session.deviceState })) };
    const emit = vi.fn();
    const executor = new RuntimeToolExecutor({
      device: { getState: async () => session.deviceState },
      queue,
      policyEngine: { evaluate: () => ({ type: 'allow' }) },
      toolCallConfig: resolveToolCallConfig(),
      deviceExecutionGate: async () => true,
      emit,
      logger: { warn: vi.fn(), error: vi.fn() },
      traceStore: {
        append: vi.fn(async () => {
          throw new Error('trace unavailable');
        }),
      },
    } as unknown as RuntimeToolExecutorOptions);
    const output = await executor['executeDeviceCommand']({
      session,
      context,
      toolCall: { id: 'stop-1', name: 'shock_stop', args: {} },
      command: { type: 'stop', channel: 'A' },
    });
    expect(queue.enqueue).toHaveBeenCalledOnce();
    expect(JSON.parse(output)._meta.kind).toBe('tool-unknown');
    expect(emit.mock.calls.map(([event]) => event.type)).toContain('runtime-warning');
    expect(emit.mock.calls.map(([event]) => event.type)).not.toContain('tool-call-failed');
  });

  it('never reports an emergency-interrupted Coyote command as executed', async () => {
    const emit = vi.fn();
    const traceStore = { append: vi.fn(async () => ({})) };
    const executor = new RuntimeToolExecutor({
      device: { getState: async () => session.deviceState },
      queue: { enqueue: async () => ({ state: session.deviceState, interrupted: true }) },
      policyEngine: { evaluate: () => ({ type: 'allow' }) },
      toolCallConfig: resolveToolCallConfig(),
      deviceExecutionGate: async () => true,
      emit,
      logger: { warn: vi.fn(), error: vi.fn() },
      traceStore,
    } as unknown as RuntimeToolExecutorOptions);
    const output = await executor['executeDeviceCommand']({
      session,
      context,
      toolCall: { id: 'start-interrupted', name: 'shock_start', args: {} },
      command: { type: 'start', channel: 'A', strength: 10, waveform: 'pulse' } as never,
    });
    expect(JSON.parse(output)._meta.kind).toBe('tool-unknown');
    expect(emit.mock.calls.map(([event]) => event.type)).not.toContain('device-command-executed');
    expect(traceStore.append).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({ kind: 'tool-unknown', toolCallId: 'start-interrupted' }),
    );
  });

  it('never reports an emergency-interrupted Opossum command as completed', async () => {
    const emit = vi.fn();
    const traceStore = { append: vi.fn(async () => ({})) };
    const executor = new RuntimeToolExecutor({
      opossum: { getState: async () => ({ connected: true }) },
      opossumQueue: { enqueue: async () => ({ state: {}, interrupted: true }) },
      opossumPolicyEngine: { evaluate: () => ({ type: 'allow' }) },
      deviceExecutionGate: async () => true,
      emit,
      logger: { warn: vi.fn(), error: vi.fn() },
      traceStore,
    } as unknown as RuntimeToolExecutorOptions);
    const output = await executor['executeOpossumCommand']({
      session,
      context,
      toolCall: { id: 'vibrate-interrupted', name: 'vibrate_start', args: {} },
      command: { type: 'vibrateStart', channel: 'A', strength: 10 } as never,
    });
    expect(JSON.parse(output)._meta.kind).toBe('tool-unknown');
    expect(emit.mock.calls.map(([event]) => event.type)).not.toContain('device-command-executed');
    expect(traceStore.append).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({ kind: 'tool-unknown', toolCallId: 'vibrate-interrupted' }),
    );
  });
});
