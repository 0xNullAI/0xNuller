import { describe, expect, it, vi } from 'vitest';
import {
  AiDeviceToolAdapter,
  type BoundDeviceTools,
  type DeviceSnapshot,
} from '@0xnullai/device-runtime';
import { ToolRegistry } from '@dg-agent/runtime';
import { DeviceRuntimeToolRegistry } from './device-runtime-tool-registry.js';

function runtimeAdapter(snapshot?: () => DeviceSnapshot | null) {
  const invoke = vi.fn(async (_name: string, input: unknown) => ({ input }));
  const tools = { invoke } as unknown as BoundDeviceTools;
  return { adapter: new AiDeviceToolAdapter({ tools: () => tools, snapshot }), invoke };
}

function vibrationSnapshot(): DeviceSnapshot {
  return {
    version: 1,
    sessionId: 'session' as DeviceSnapshot['sessionId'],
    sequence: 1,
    topologyGeneration: 1,
    safetyGeneration: 1,
    devices: [
      {
        deviceId: 'device' as DeviceSnapshot['devices'][number]['deviceId'],
        name: 'device',
        capabilities: [
          { kind: 'vibrate', featureId: 'feature' as never, stepCount: 20, faulted: false },
        ],
      },
    ],
  };
}

describe('DeviceRuntimeToolRegistry', () => {
  it('keeps legacy DG tools and adds only the generic positive allowlist', async () => {
    const legacy = new ToolRegistry();
    legacy.register({
      name: 'shock_stop',
      definition: {
        name: 'shock_stop',
        description: 'legacy stop',
        parameters: { type: 'object', properties: {} },
      },
      toExecutionPlan: () => ({ type: 'inline', output: 'legacy' }),
    });
    const { adapter } = runtimeAdapter(vibrationSnapshot);
    const registry = new DeviceRuntimeToolRegistry(legacy, adapter);

    expect((await registry.listDefinitions()).map((definition) => definition.name)).toEqual([
      'shock_stop',
      'device_snapshot',
      'device_vibrate',
      'device_stop',
      'device_emergency_stop',
    ]);
  });

  it('removes generic definitions on the next list when the last vibration target disconnects', async () => {
    const legacy = new ToolRegistry();
    let snapshot: DeviceSnapshot | null = vibrationSnapshot();
    const { adapter } = runtimeAdapter(() => snapshot);
    const registry = new DeviceRuntimeToolRegistry(legacy, adapter);

    expect((await registry.listDefinitions()).map((definition) => definition.name)).toContain(
      'device_vibrate',
    );
    snapshot = { ...vibrationSnapshot(), devices: [] };
    expect(await registry.listDefinitions()).toEqual([]);
  });

  it('passes the Agent tool-call id to the runtime adapter and delegates legacy calls unchanged', async () => {
    const legacyResolve = vi.fn(async () => ({ type: 'inline' as const, output: 'legacy' }));
    const legacy = new ToolRegistry();
    legacy.resolve = legacyResolve;
    const { adapter, invoke } = runtimeAdapter(vibrationSnapshot);
    const registry = new DeviceRuntimeToolRegistry(legacy, adapter);

    await registry.resolve({
      id: 'agent-tool-call',
      name: 'device_stop',
      args: { deviceId: 'opaque-device', featureId: 'opaque-feature' },
    });
    expect(invoke).toHaveBeenCalledWith('device_stop', {
      interactionId: 'agent-tool-call',
      deviceId: 'opaque-device',
      featureId: 'opaque-feature',
    });

    const legacyCall = { id: 'legacy-call', name: 'shock_stop', args: { channel: 'A' } };
    await registry.resolve(legacyCall);
    expect(legacyResolve).toHaveBeenCalledWith(legacyCall);
  });
});
