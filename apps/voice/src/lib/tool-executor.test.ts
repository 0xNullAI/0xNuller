import { createEmptyDeviceState, type DeviceCommand, type ToolExecutionPlan } from '@dg-kit/core';
import { createEmptyOpossumState } from '@dg-kit/protocol';
import { grantDeviceLease } from '@dg-kit/safety';
import { ToolRegistry } from '@dg-kit/tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeviceSession } from './device-session.js';
import { ToolExecutor } from './tool-executor.js';

afterEach(async () => {
  await grantDeviceLease(null);
});

function harness(plan: ToolExecutionPlan) {
  let targetId: string | null = 'voice-coyote/first';
  const coyoteState = { ...createEmptyDeviceState(), connected: true };
  const opossumState = createEmptyOpossumState();
  const registry = new ToolRegistry();
  registry.register({
    name: plan.type === 'device' && plan.command.type === 'stop' ? 'shock_stop' : 'shock_adjust',
    definition: { name: 'test', description: 'test', parameters: {} },
    toExecutionPlan: () => plan,
  });
  const deviceQueue = {
    enqueue: vi.fn(async () => ({ state: coyoteState, notes: [] })),
  };
  const session = {
    coyote: { getState: vi.fn(async () => coyoteState) },
    opossum: { getState: vi.fn(async () => opossumState) },
    getState: vi.fn(async () => ({ coyote: coyoteState, opossum: opossumState })),
    currentTargetId: vi.fn(() => targetId),
  } as unknown as DeviceSession;
  const permission = { request: vi.fn(async () => ({ type: 'approve-once' as const })) };
  const policyEngine = {
    evaluate: vi.fn(({ command }: { command: DeviceCommand }) =>
      command.type === 'stop'
        ? { type: 'allow' as const }
        : { type: 'require-confirm' as const, command },
    ),
  };
  const executor = new ToolExecutor({
    session,
    registry,
    policyEngine: policyEngine as never,
    opossumPolicyEngine: { evaluate: vi.fn() } as never,
    permission,
    deviceQueue: deviceQueue as never,
    opossumQueue: { enqueue: vi.fn() } as never,
    context: { sessionId: 'voice', sourceType: 'web', traceId: 'voice-test' },
  });
  return {
    executor,
    deviceQueue,
    permission,
    setTargetId: (value: string | null) => {
      targetId = value;
    },
  };
}

describe('Voice legacy execution fences', () => {
  it('rejects an approved output when the singleton connection identity changes before dispatch', async () => {
    await grantDeviceLease('voice');
    const command: DeviceCommand = { type: 'adjustStrength', channel: 'A', delta: 1 };
    const test = harness({ type: 'device', command });
    test.permission.request.mockImplementationOnce(async () => {
      test.setTargetId('voice-coyote/reconnected');
      return { type: 'approve-once' as const };
    });

    const result = await test.executor.execute({ id: 'call', name: 'shock_adjust', args: {} });
    expect(JSON.parse(result.output)).toMatchObject({
      error: expect.stringContaining('身份或控制权已变化'),
    });
    expect(test.deviceQueue.enqueue).not.toHaveBeenCalled();
  });

  it('rejects an approved output when the module lease changes before dispatch', async () => {
    await grantDeviceLease('voice');
    const command: DeviceCommand = { type: 'adjustStrength', channel: 'A', delta: 1 };
    const test = harness({ type: 'device', command });
    test.permission.request.mockImplementationOnce(async () => {
      await grantDeviceLease('control');
      return { type: 'approve-once' as const };
    });

    const result = await test.executor.execute({ id: 'call', name: 'shock_adjust', args: {} });
    expect(JSON.parse(result.output)).toMatchObject({
      error: expect.stringContaining('身份或控制权已变化'),
    });
    expect(test.deviceQueue.enqueue).not.toHaveBeenCalled();
  });

  it('keeps stop reachable after lease loss and connection identity revocation', async () => {
    await grantDeviceLease('control');
    const test = harness({ type: 'device', command: { type: 'stop', channel: 'A' } });
    test.setTargetId(null);

    const result = await test.executor.execute({ id: 'stop', name: 'shock_stop', args: {} });
    expect(JSON.parse(result.output)).toMatchObject({ ok: true });
    expect(test.deviceQueue.enqueue).toHaveBeenCalledWith({ type: 'stop', channel: 'A' });
  });
});
