import { describe, expect, it, vi } from 'vitest';
import {
  AiDeviceToolAdapter,
  formatAiDeviceRuntimeStatus,
  type BoundDeviceTools,
  type DeviceSnapshot,
} from '@0xnullai/device-runtime';
import { createEmptyDeviceState } from '@dg-kit/core';
import { createEmptyOpossumState } from '@dg-kit/protocol';
import { ToolRegistry } from '@dg-kit/tools';
import {
  listVoiceToolDefinitions,
  voiceToolAvailability,
  VoiceCompositeToolExecutor,
} from './device-runtime-tools.js';

const context = { sessionId: 'voice', sourceType: 'web' as const, traceId: 'voice-trace' };

function runtimeHarness(snapshot?: DeviceSnapshot) {
  const invoke = vi.fn(async (_name: string, input: unknown) => ({ input }));
  const tools = { invoke } as unknown as BoundDeviceTools;
  return {
    adapter: new AiDeviceToolAdapter({ tools: () => tools, snapshot: () => snapshot ?? null }),
    invoke,
  };
}

const disconnectedState = {
  coyote: createEmptyDeviceState(),
  opossum: createEmptyOpossumState(),
};

const genericSnapshot = {
  version: 1,
  sessionId: 'session',
  sequence: 1,
  topologyGeneration: 1,
  safetyGeneration: 1,
  devices: [
    {
      deviceId: 'device',
      name: 'device',
      capabilities: [{ kind: 'vibrate', featureId: 'feature', stepCount: 10, faulted: false }],
    },
  ],
} as unknown as DeviceSnapshot;

describe('Voice generic device tools', () => {
  it('converts the generic allowlist without retaining disconnected legacy device tools', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'shock_stop',
      definition: {
        name: 'shock_stop',
        description: 'legacy',
        parameters: { type: 'object', properties: {} },
      },
      toExecutionPlan: () => ({ type: 'inline', output: 'legacy' }),
    });
    const { adapter } = runtimeHarness(genericSnapshot);
    const availability = voiceToolAvailability(disconnectedState, adapter, true);
    expect(
      (await listVoiceToolDefinitions(registry, availability, adapter)).map((tool) => tool.name),
    ).toEqual(['device_snapshot', 'device_vibrate', 'device_stop', 'device_emergency_stop']);
  });

  it('only exposes tools for connected legacy devices and enabled usable generic capabilities', async () => {
    const registry = new ToolRegistry();
    for (const name of ['shock_start', 'vibrate_start', 'timer']) {
      registry.register({
        name,
        definition: { name, description: name, parameters: {} },
        toExecutionPlan: () => ({ type: 'inline', output: name }),
      });
    }
    const { adapter } = runtimeHarness(genericSnapshot);

    const none = voiceToolAvailability(disconnectedState, adapter, false);
    expect(
      (await listVoiceToolDefinitions(registry, none, adapter)).map((tool) => tool.name),
    ).toEqual(['timer']);

    const coyote = voiceToolAvailability(
      { ...disconnectedState, coyote: { ...disconnectedState.coyote, connected: true } },
      adapter,
      false,
    );
    expect(
      (await listVoiceToolDefinitions(registry, coyote, adapter)).map((tool) => tool.name),
    ).toEqual(['shock_start', 'timer']);

    const generic = voiceToolAvailability(disconnectedState, adapter, true);
    expect(
      (await listVoiceToolDefinitions(registry, generic, adapter)).map((tool) => tool.name),
    ).toEqual([
      'timer',
      'device_snapshot',
      'device_vibrate',
      'device_stop',
      'device_emergency_stop',
    ]);

    const faultedSnapshot = {
      ...genericSnapshot,
      devices: genericSnapshot.devices.map((device) => ({
        ...device,
        capabilities: device.capabilities.map((capability) => ({
          ...capability,
          faulted: true,
        })),
      })),
    } as unknown as DeviceSnapshot;
    const faulted = voiceToolAvailability(
      disconnectedState,
      runtimeHarness(faultedSnapshot).adapter,
      true,
    );
    expect(faulted.generic).toBe(false);
  });

  it('routes runtime names with the provider call id and leaves legacy names unchanged', async () => {
    const legacy = { execute: vi.fn(async () => ({ toolCallId: 'legacy', output: 'legacy' })) };
    const permission = { request: vi.fn(async () => ({ type: 'approve-once' as const })) };
    const onRuntimeToolComplete = vi.fn(async () => undefined);
    const { adapter, invoke } = runtimeHarness();
    const executor = new VoiceCompositeToolExecutor({
      legacy,
      runtime: adapter,
      permission,
      context,
      onRuntimeToolComplete,
    });

    await executor.execute({
      id: 'voice-tool-call',
      name: 'device_vibrate',
      args: {
        deviceId: 'opaque-device',
        featureId: 'opaque-feature',
        intensity: 0.2,
        outputLeaseMs: 300,
      },
    });
    expect(permission.request).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('device_vibrate', {
      interactionId: 'voice-tool-call',
      deviceId: 'opaque-device',
      featureId: 'opaque-feature',
      intensity: 0.2,
      outputLeaseMs: 300,
    });
    expect(onRuntimeToolComplete).toHaveBeenCalledTimes(1);

    const legacyCall = { id: 'old', name: 'shock_stop', args: { channel: 'A' } };
    await executor.execute(legacyCall);
    expect(legacy.execute).toHaveBeenCalledWith(legacyCall);
  });

  it('routes one exact opaque target when multiple generic devices share the same name', async () => {
    const sameNameSnapshot = {
      ...genericSnapshot,
      devices: ['device-one', 'device-two'].map((deviceId, index) => ({
        deviceId,
        name: 'Same advertised name',
        capabilities: [
          {
            kind: 'vibrate',
            featureId: `feature-${index + 1}`,
            stepCount: 10,
            faulted: false,
          },
        ],
      })),
    } as unknown as DeviceSnapshot;
    const { adapter, invoke } = runtimeHarness(sameNameSnapshot);

    await adapter.invoke({
      id: 'voice-exact-target',
      name: 'device_vibrate',
      args: {
        deviceId: 'device-two',
        featureId: 'feature-2',
        intensity: 0.25,
        outputLeaseMs: 300,
      },
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('device_vibrate', {
      interactionId: 'voice-exact-target',
      deviceId: 'device-two',
      featureId: 'feature-2',
      intensity: 0.25,
      outputLeaseMs: 300,
    });
    const promptStatus = formatAiDeviceRuntimeStatus(adapter.snapshot()!);
    expect(promptStatus).not.toContain('Same advertised name');
    expect(promptStatus).toContain('device-one');
    expect(promptStatus).toContain('device-two');
  });

  it('keeps runtime vibration behind Voice permission while stop remains reachable', async () => {
    const legacy = { execute: vi.fn() };
    const permission = {
      request: vi.fn(async () => ({ type: 'deny' as const, reason: 'denied locally' })),
    };
    const { adapter, invoke } = runtimeHarness();
    const executor = new VoiceCompositeToolExecutor({
      legacy,
      runtime: adapter,
      permission,
      context,
    });

    const denied = await executor.execute({
      id: 'deny-vibrate',
      name: 'device_vibrate',
      args: {
        deviceId: 'device',
        featureId: 'feature',
        intensity: 0.2,
        outputLeaseMs: 300,
      },
    });
    expect(JSON.parse(denied.output)).toMatchObject({ error: 'denied locally' });
    expect(invoke).not.toHaveBeenCalled();

    await executor.execute({
      id: 'stop-now',
      name: 'device_emergency_stop',
      args: {},
    });
    expect(permission.request).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('device_emergency_stop', {
      interactionId: 'stop-now',
    });
  });
});
