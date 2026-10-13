import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceState } from '@dg-agent/core';
import type { BluetoothRemoteGATTServerLike } from '@dg-kit/protocol';
import { DGLAB_SAFETY_SESSION_ID, type DgLabConnectionRegistry } from '@0xnullai/device-runtime';
import { createUnifiedShellDgLabRegistry } from '@0xnullai/web/dglab-device-registry';
import { safetySessionById } from '@dg-kit/safety';

/**
 * The Android composition of the shared DG-Lab registry, with plugin-blec replaced by a fake at
 * the kit boundary. Real BLE and real Android pause delivery still need a device.
 */

const ble = vi.hoisted(() => {
  const server = {} as BluetoothRemoteGATTServerLike;
  const gatt = {
    connected: true,
    connect: async () => server,
    disconnect: () => {
      gatt.connected = false;
    },
  };
  const device = Object.assign(new EventTarget(), { id: 'AA:BB', name: '47L1210000XX', gatt });

  class FakeTauriBlecDeviceClient {
    static instances: FakeTauriBlecDeviceClient[] = [];
    readonly calls: string[] = [];
    private state = { connected: false, strengthA: 0, strengthB: 0 } as DeviceState;
    private readonly listeners = new Set<(state: DeviceState) => void>();
    constructor(readonly options: { protocol: unknown; namePrefixes?: string[] }) {
      FakeTauriBlecDeviceClient.instances.push(this);
    }
    async connect() {
      this.calls.push('connect');
    }
    async connectDevice(picked: unknown, pickedServer: unknown) {
      this.calls.push(picked === device && pickedServer === server ? 'connectDevice' : 'wrong');
      this.state = { ...this.state, connected: true };
      for (const listener of this.listeners) listener(this.state);
    }
    async disconnect() {
      this.calls.push('disconnect');
      this.state = { ...this.state, connected: false };
    }
    async execute() {
      return { state: this.state, notes: [] };
    }
    async emergencyStop() {
      this.calls.push('emergencyStop');
    }
    async getState() {
      return this.state;
    }
    onStateChanged(listener: (state: DeviceState) => void) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }
  }

  return {
    server,
    device,
    FakeTauriBlecDeviceClient,
    requestDgLabDeviceTauri: vi.fn(async () => ({ kind: 'coyote' as const, device, server })),
    pauseHandlers: [] as (() => void)[],
  };
});

vi.mock('@dg-kit/transport-tauri-blec', () => ({
  TauriBlecDeviceClient: ble.FakeTauriBlecDeviceClient,
  TauriBlecOpossumClient: class {},
  TauriBlecPawPrintsClient: class {},
  TauriBlecCivetEdgingClient: class {},
  requestDgLabDeviceTauri: ble.requestDgLabDeviceTauri,
}));
vi.mock('./components/show-device-picker', () => ({ showDevicePicker: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, handler: () => void) => {
    if (name === 'app://paused') ble.pauseHandlers.push(handler);
    return () => {
      ble.pauseHandlers.splice(ble.pauseHandlers.indexOf(handler), 1);
    };
  },
}));

const { createTauriDgLabTransport } = await import('./tauri-dglab-transport');
const { attachAndroidDgLabLifecycle } = await import('./lifecycle-safety');

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

let registry: DgLabConnectionRegistry;
let permissionHelp: ReturnType<typeof vi.fn>;
let connectHelp: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  ble.FakeTauriBlecDeviceClient.instances.length = 0;
  ble.device.gatt.connected = true;
  permissionHelp = vi.fn(<T>(call: () => Promise<T>) => call());
  connectHelp = vi.fn(<T>(client: T) => client);
  registry = createUnifiedShellDgLabRegistry({
    transport: createTauriDgLabTransport({
      connectHelp: connectHelp as never,
      permissionHelp: permissionHelp as never,
    }),
    attachNativeLifecycle: attachAndroidDgLabLifecycle,
    backgroundKeep: false,
  });
  // Let the async Tauri listener registration finish.
  await tick();
});

afterEach(async () => {
  await registry.dispose();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe('Tauri DG-Lab transport', () => {
  it('connects a picked Coyote through the permission help and the lifecycle-wrapped client', async () => {
    expect(safetySessionById(DGLAB_SAFETY_SESSION_ID)?.devices?.()).toEqual([]);

    const snapshot = await registry.connect();

    expect(permissionHelp).toHaveBeenCalledTimes(1);
    expect(ble.requestDgLabDeviceTauri).toHaveBeenCalledTimes(1);
    const [client] = ble.FakeTauriBlecDeviceClient.instances;
    expect(ble.FakeTauriBlecDeviceClient.instances).toHaveLength(1);
    expect(client!.options.namePrefixes).toEqual(['47L121', 'D-LAB']);
    expect(client!.options.protocol).toBeDefined();
    expect(connectHelp).toHaveBeenCalledTimes(1);
    // Attached to the picked pair, never re-scanned; the registry zeroes output on attach.
    expect(client!.calls[0]).toBe('connectDevice');
    expect(client!.calls).not.toContain('connect');
    expect(client!.calls).toContain('emergencyStop');
    expect(snapshot).toMatchObject({ kind: 'coyote', connected: true });
    expect(safetySessionById(DGLAB_SAFETY_SESSION_ID)?.devices?.()).toHaveLength(1);
  });

  it('stops every registry device on Android pause', async () => {
    await registry.connect();
    const [client] = ble.FakeTauriBlecDeviceClient.instances;
    client!.calls.length = 0;
    const stopAll = vi.spyOn(registry, 'stopAll');

    expect(ble.pauseHandlers.length).toBeGreaterThan(0);
    for (const handler of [...ble.pauseHandlers]) handler();
    await tick();

    expect(stopAll).toHaveBeenCalled();
    expect(client!.calls).toContain('emergencyStop');
  });

  it('stops every registry device when the WebView is hidden', async () => {
    await registry.connect();
    const stopAll = vi.spyOn(registry, 'stopAll');

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await tick();

    expect(stopAll).toHaveBeenCalled();
  });
});
