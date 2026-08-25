import { describe, expect, it, vi } from 'vitest';
import type { BackendDevice, DeviceBackend, DeviceBackendSession } from './contracts.js';
import { DeviceRuntimeManager } from './manager.js';
import { DeviceSchemaError } from './schemas.js';

function backendHarness() {
  let emit: (event: unknown) => void = () => {
    throw new Error('backend not open');
  };
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
  return { backend, session, emit: (event: unknown) => emit(event) };
}

function device(nativeDeviceId: string, featureCount = 1): BackendDevice {
  return {
    nativeDeviceId,
    name: `Device ${nativeDeviceId}`,
    capabilities: Array.from({ length: featureCount }, (_, index) => ({
      kind: 'vibrate' as const,
      nativeFeatureId: `v${index}`,
      stepCount: 100,
    })),
  };
}

function topology(devices: readonly BackendDevice[]) {
  return { version: 1, type: 'topology', devices };
}

describe('DeviceRuntimeManager', () => {
  it('owns one backend session and publishes monotonic, ordered snapshots', async () => {
    const harness = backendHarness();
    const manager = new DeviceRuntimeManager(harness.backend, { idFactory: () => 'test' });
    const seen: number[] = [];
    manager.subscribe((snapshot) => seen.push(snapshot.sequence));
    await manager.start();

    harness.emit(
      topology([
        {
          nativeDeviceId: 'b',
          name: 'Second from backend',
          capabilities: [
            { kind: 'battery', nativeFeatureId: 'battery', value: 0.8 },
            { kind: 'rssi', nativeFeatureId: 'rssi', value: -45 },
          ],
        },
        device('a'),
      ]),
    );
    const first = manager.snapshot();
    expect(first.devices.map((item) => item.name)).toEqual(['Second from backend', 'Device a']);
    expect(first.devices[0]?.capabilities.map((item) => item.kind)).toEqual(['battery', 'rssi']);
    expect(JSON.stringify(first)).not.toContain('nativeDeviceId');
    expect(JSON.stringify(first)).not.toContain('nativeFeatureId');

    harness.emit(topology([device('a')]));
    const second = manager.snapshot();
    expect(second.topologyGeneration).toBeGreaterThan(first.topologyGeneration);
    expect(second.safetyGeneration).toBeGreaterThan(first.safetyGeneration);
    expect(second.sequence).toBeGreaterThan(first.sequence);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    await expect(manager.start()).rejects.toThrow(/only be opened once/);
    expect(harness.backend.openSession).toHaveBeenCalledTimes(1);
  });

  it('updates telemetry without invalidating topology or safety fences', async () => {
    const harness = backendHarness();
    const manager = new DeviceRuntimeManager(harness.backend, { idFactory: () => 'telemetry' });
    await manager.start();
    harness.emit(
      topology([
        {
          nativeDeviceId: 'one',
          name: 'Telemetry device',
          capabilities: [
            { kind: 'vibrate', nativeFeatureId: 'vibrate', stepCount: 100 },
            { kind: 'battery', nativeFeatureId: 'battery', value: 0.8 },
            { kind: 'rssi', nativeFeatureId: 'rssi', value: -45 },
          ],
        },
      ]),
    );
    const before = manager.snapshot();

    harness.emit(
      topology([
        {
          nativeDeviceId: 'one',
          name: 'Renamed telemetry device',
          capabilities: [
            { kind: 'vibrate', nativeFeatureId: 'vibrate', stepCount: 100 },
            { kind: 'battery', nativeFeatureId: 'battery', value: 0.6 },
            { kind: 'rssi', nativeFeatureId: 'rssi', value: -60 },
          ],
        },
      ]),
    );
    const after = manager.snapshot();

    expect(after.topologyGeneration).toBe(before.topologyGeneration);
    expect(after.safetyGeneration).toBe(before.safetyGeneration);
    expect(after.sequence).toBeGreaterThan(before.sequence);
    expect(after.devices[0]?.deviceId).toBe(before.devices[0]?.deviceId);
    expect(after.devices[0]?.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'battery', value: 0.6 }),
        expect.objectContaining({ kind: 'rssi', value: -60 }),
      ]),
    );
  });

  it('scopes opaque ids to one appearance and rejects stale ids after reappearance', async () => {
    const harness = backendHarness();
    const manager = new DeviceRuntimeManager(harness.backend, { idFactory: () => 'scope' });
    await manager.start();
    harness.emit(topology([device('native-secret')]));
    const old = manager.snapshot().devices[0]!;
    const oldFeature = old.capabilities[0]!;

    harness.emit(topology([]));
    harness.emit(topology([device('native-secret')]));
    const fresh = manager.snapshot().devices[0]!;
    expect(fresh.deviceId).not.toBe(old.deviceId);
    expect(fresh.capabilities[0]!.featureId).not.toBe(oldFeature.featureId);
    expect(manager.resolveVibrateTarget(old.deviceId, oldFeature.featureId)).toBeNull();
  });

  it.each([
    ['more than 8 devices', Array.from({ length: 9 }, (_, index) => device(String(index)))],
    ['more than 8 features on a device', [device('one', 9)]],
    [
      'more than 32 total features',
      [device('a', 8), device('b', 8), device('c', 8), device('d', 8), device('e', 1)],
    ],
  ])('rejects topology limit: %s', async (_label, devices) => {
    const harness = backendHarness();
    const manager = new DeviceRuntimeManager(harness.backend, { idFactory: () => 'limits' });
    await manager.start();
    expect(() => harness.emit(topology(devices))).toThrow(DeviceSchemaError);
    expect(manager.snapshot().devices).toHaveLength(0);
  });

  it('accepts exactly 8 devices, 8 features each, and 32 total features', async () => {
    const harness = backendHarness();
    const manager = new DeviceRuntimeManager(harness.backend, { idFactory: () => 'boundaries' });
    await manager.start();
    const devices = Array.from({ length: 8 }, (_, index) => device(String(index), 4));
    expect(() => harness.emit(topology(devices))).not.toThrow();
    expect(manager.snapshot().devices).toHaveLength(8);
    expect(
      manager.snapshot().devices.reduce((sum, item) => sum + item.capabilities.length, 0),
    ).toBe(32);
  });

  it('does not auto-reconnect or restore output after terminal session loss', async () => {
    const harness = backendHarness();
    const manager = new DeviceRuntimeManager(harness.backend, { idFactory: () => 'terminal' });
    await manager.start();
    harness.emit(topology([device('one')]));
    const before = manager.snapshot();

    harness.emit({ version: 1, type: 'session-ended', reason: 'bluetooth-off' });
    expect(manager.snapshot().devices).toEqual([]);
    expect(manager.snapshot().topologyGeneration).toBeGreaterThan(before.topologyGeneration);
    await expect(manager.scan()).rejects.toThrow('backend-session-unavailable');
    await expect(manager.start()).rejects.toThrow(/only be opened once/);
    expect(harness.backend.openSession).toHaveBeenCalledTimes(1);
    expect(harness.session.writeVibrate).not.toHaveBeenCalled();
    expect(harness.session.close).toHaveBeenCalledTimes(1);

    // Late events from the ended adapter cannot resurrect devices.
    harness.emit(topology([device('one')]));
    expect(manager.snapshot().devices).toEqual([]);
  });
});
