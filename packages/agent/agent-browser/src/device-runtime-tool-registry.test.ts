import { describe, expect, it, vi } from 'vitest';
import { AiDeviceToolAdapter, type BoundDeviceTools } from '@0xnullai/device-runtime';
import { ToolRegistry } from '@dg-agent/runtime';
import { DeviceRuntimeToolRegistry } from './device-runtime-tool-registry.js';

function runtimeAdapter() {
  const invoke = vi.fn(async (_name: string, input: unknown) => ({ input }));
  const tools = { invoke } as unknown as BoundDeviceTools;
  return { adapter: new AiDeviceToolAdapter({ tools: () => tools }), invoke };
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
    const { adapter } = runtimeAdapter();
    const registry = new DeviceRuntimeToolRegistry(legacy, adapter);

    expect((await registry.listDefinitions()).map((definition) => definition.name)).toEqual([
      'shock_stop',
      'device_snapshot',
      'device_vibrate',
      'device_stop',
      'device_emergency_stop',
    ]);
  });

  it('passes the Agent tool-call id to the runtime adapter and delegates legacy calls unchanged', async () => {
    const legacyResolve = vi.fn(async () => ({ type: 'inline' as const, output: 'legacy' }));
    const legacy = new ToolRegistry();
    legacy.resolve = legacyResolve;
    const { adapter, invoke } = runtimeAdapter();
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
