import { describe, expect, it, vi } from 'vitest';
import type { DeviceBackend, DeviceBackendSession } from './contracts.js';
import { DeviceRuntimeExecutor } from './executor.js';
import { DeviceRuntimeManager } from './manager.js';
import { DEVICE_TOOL_CATALOG, DeviceToolProvider } from './tool-provider.js';

async function providerHarness() {
  let emit: (event: unknown) => void = () => undefined;
  const session: DeviceBackendSession = {
    scan: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    writeVibrate: vi.fn(async () => undefined),
    stopFeature: vi.fn(async () => undefined),
    stopAll: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const backend: DeviceBackend = {
    openSession: vi.fn(async (listener) => {
      emit = listener;
      return session;
    }),
  };
  const manager = new DeviceRuntimeManager(backend, { idFactory: () => 'tools' });
  await manager.start();
  emit({
    version: 1,
    type: 'topology',
    devices: [
      {
        nativeDeviceId: 'native',
        name: 'Tool device',
        capabilities: [{ kind: 'vibrate', nativeFeatureId: 'vibrate', stepCount: 10 }],
      },
    ],
  });
  const executor = new DeviceRuntimeExecutor(manager, {
    permissionPolicy: { authorize: async () => 'allow' },
    safetyPolicy: () => ({
      intensityCap: 1,
      maxIncrease: 1,
      coldStartCap: 1,
      maxOutputLeaseMs: 5_000,
    }),
    leaseSnapshot: () => ({ holder: 'agent', epoch: 1 }),
  });
  return { manager, session, provider: new DeviceToolProvider(manager, executor) };
}

describe('DeviceToolProvider', () => {
  it('provides one SDK-free catalog and typed actions over the same executor', async () => {
    const harness = await providerHarness();
    const tools = harness.provider.forModule('agent');
    expect(tools.catalog).toBe(DEVICE_TOOL_CATALOG);
    expect(tools.catalog.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(
      true,
    );
    expect(tools.catalog.map((tool) => tool.name)).toEqual([
      'device_snapshot',
      'device_scan',
      'device_disconnect',
      'device_vibrate',
      'device_stop',
      'device_emergency_stop',
    ]);

    const snapshot = tools.actions.snapshot();
    const device = snapshot.devices[0]!;
    const feature = device.capabilities[0]!;
    await expect(
      tools.actions.vibrate({
        interactionId: 'typed-control',
        deviceId: device.deviceId,
        featureId: feature.featureId,
        intensity: 0.29,
        outputLeaseMs: 500,
      }),
    ).resolves.toMatchObject({ status: 'applied', appliedIntensity: 0.2 });
    expect(harness.session.writeVibrate).toHaveBeenCalledWith('native', 'vibrate', 0.2);
  });

  it('strictly rejects unknown tool fields and Raw-style actions', async () => {
    const harness = await providerHarness();
    const tools = harness.provider.forModule('agent');
    await expect(
      tools.invoke('device_vibrate', {
        interactionId: 'raw',
        deviceId: 'device',
        featureId: 'feature',
        intensity: 0.5,
        outputLeaseMs: 100,
        raw: [0xff],
      }),
    ).rejects.toThrow(/unknown field/);
    await expect(tools.invoke('device_snapshot', { unexpected: true })).rejects.toThrow(
      /unknown field/,
    );
    expect(DEVICE_TOOL_CATALOG.some((tool) => /raw/i.test(tool.name))).toBe(false);
  });

  it('never exposes backend-native identifiers in snapshot tool results', async () => {
    const harness = await providerHarness();
    const result = await harness.provider.forModule('agent').invoke('device_snapshot', {});
    expect(JSON.stringify(result)).not.toContain('nativeDeviceId');
    expect(JSON.stringify(result)).not.toContain('nativeFeatureId');
  });
});
