import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TauriBlecDeviceClient,
  type DiscoveredDevice,
} from './client.js';
import {
  __setPluginBlecForTests,
  type BleDeviceInfo,
  type PluginBlecApi,
} from './plugin-blec.js';

class FakeProtocol {
  public connectedContext: { deviceName: string } | null = null;
  public disconnectedCount = 0;
  public executed: unknown[] = [];
  private listener: ((s: unknown) => void) | null = null;

  subscribe(listener: (state: unknown) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }
  async onConnected(context: { device: { name?: string } }): Promise<void> {
    this.connectedContext = { deviceName: context.device.name ?? '' };
  }
  async onDisconnected(): Promise<void> {
    this.disconnectedCount += 1;
  }
  getState(): unknown {
    return { connected: !!this.connectedContext };
  }
  async execute(command: unknown): Promise<{ ok: true }> {
    this.executed.push(command);
    return { ok: true };
  }
  async emergencyStop(): Promise<void> {
    return;
  }
  async setLimits(_a: number, _b: number): Promise<void> {
    return;
  }
}

function makeApi(overrides: Partial<PluginBlecApi> = {}): PluginBlecApi {
  return {
    checkPermissions: vi.fn().mockResolvedValue(true),
    startScan: vi.fn().mockResolvedValue(undefined),
    stopScan: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockResolvedValue([]),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeDevice(over: Partial<BleDeviceInfo> = {}): BleDeviceInfo {
  return {
    address: 'AA:BB:CC',
    name: '47L1210000XX',
    rssi: -60,
    isConnected: false,
    isBonded: false,
    services: [],
    manufacturerData: {},
    serviceData: {},
    ...over,
  };
}

afterEach(() => __setPluginBlecForTests(undefined));

describe('TauriBlecDeviceClient.connect', () => {
  it('checks permissions, scans, lets UI pick, then connects', async () => {
    const api = makeApi({
      startScan: vi.fn().mockImplementation(
        async (handler: (devices: BleDeviceInfo[]) => void) => {
          // simulate plugin-blec emitting device immediately
          setTimeout(() => handler([makeDevice()]), 5);
        },
      ),
    });
    __setPluginBlecForTests(api);

    const protocol = new FakeProtocol();
    const selectDevice = vi.fn().mockImplementation(
      async (controller: { initial: DiscoveredDevice[]; subscribe: (h: (d: DiscoveredDevice[]) => void) => () => void }) => {
        // wait for the scan handler to push at least one device
        const devices = await new Promise<DiscoveredDevice[]>((resolve) => {
          if (controller.initial.length) return resolve(controller.initial);
          const off = controller.subscribe((next) => {
            if (next.length) {
              off();
              resolve(next);
            }
          });
        });
        expect(devices).toHaveLength(1);
        expect(devices[0]?.name).toBe('47L1210000XX');
        return devices[0]!.address;
      },
    );

    const client = new TauriBlecDeviceClient({
      protocol: protocol as never,
      selectDevice,
      scanDurationMs: 50,
    });
    await client.connect();

    expect(api.checkPermissions).toHaveBeenCalledWith(true);
    expect(api.startScan).toHaveBeenCalled();
    expect(api.stopScan).toHaveBeenCalled();
    expect(api.connect).toHaveBeenCalledWith('AA:BB:CC', expect.any(Function));
    expect(protocol.connectedContext?.deviceName).toBe('47L1210000XX');
  });

  it('throws when permissions are denied', async () => {
    const api = makeApi({
      checkPermissions: vi.fn().mockResolvedValue(false),
    });
    __setPluginBlecForTests(api);
    const protocol = new FakeProtocol();
    const client = new TauriBlecDeviceClient({
      protocol: protocol as never,
      selectDevice: vi.fn(),
      scanDurationMs: 50,
    });
    await expect(client.connect()).rejects.toThrow(/权限/);
    expect(api.startScan).not.toHaveBeenCalled();
  });

  it('aborts cleanly when selectDevice returns null', async () => {
    const api = makeApi({
      startScan: vi.fn().mockImplementation(
        async (handler: (devices: BleDeviceInfo[]) => void) => {
          setTimeout(() => handler([makeDevice()]), 5);
        },
      ),
    });
    __setPluginBlecForTests(api);
    const protocol = new FakeProtocol();
    const client = new TauriBlecDeviceClient({
      protocol: protocol as never,
      selectDevice: vi.fn().mockResolvedValue(null) as never,
      scanDurationMs: 50,
    });
    await expect(client.connect()).rejects.toThrow(/取消/);
    expect(api.connect).not.toHaveBeenCalled();
    expect(protocol.connectedContext).toBeNull();
  });

  it('filters devices by namePrefixes', async () => {
    const api = makeApi({
      startScan: vi.fn().mockImplementation(
        async (handler: (devices: BleDeviceInfo[]) => void) => {
          setTimeout(
            () =>
              handler([
                makeDevice({ address: 'A', name: '47L1210000XX' }),
                makeDevice({ address: 'B', name: 'AirPods' }),
                makeDevice({ address: 'C', name: 'D-LAB ESTIM01' }),
              ]),
            5,
          );
        },
      ),
    });
    __setPluginBlecForTests(api);
    const protocol = new FakeProtocol();
    let captured: DiscoveredDevice[] = [];
    const client = new TauriBlecDeviceClient({
      protocol: protocol as never,
      selectDevice: async (controller) => {
        const devices = await new Promise<DiscoveredDevice[]>((resolve) => {
          if (controller.initial.length) return resolve(controller.initial);
          const off = controller.subscribe((next) => {
            if (next.length) {
              off();
              resolve(next);
            }
          });
        });
        captured = devices;
        return null;
      },
      namePrefixes: ['47L121', 'D-LAB'],
      scanDurationMs: 50,
    });
    await expect(client.connect()).rejects.toThrow();
    expect(captured.map((d) => d.address).sort()).toEqual(['A', 'C']);
  });

  it('disconnect callback from plugin-blec triggers protocol.onDisconnected', async () => {
    let onDisc: (() => void) | null = null;
    const api = makeApi({
      startScan: vi.fn().mockImplementation(
        async (handler: (devices: BleDeviceInfo[]) => void) => {
          setTimeout(() => handler([makeDevice()]), 5);
        },
      ),
      connect: vi.fn().mockImplementation(async (_a, cb: () => void) => {
        onDisc = cb;
      }),
    });
    __setPluginBlecForTests(api);
    const protocol = new FakeProtocol();
    const client = new TauriBlecDeviceClient({
      protocol: protocol as never,
      selectDevice: async (controller) => {
        const devices = await new Promise<DiscoveredDevice[]>((resolve) => {
          if (controller.initial.length) return resolve(controller.initial);
          const off = controller.subscribe((next) => {
            if (next.length) {
              off();
              resolve(next);
            }
          });
        });
        return devices[0]!.address;
      },
      scanDurationMs: 50,
    });
    await client.connect();
    expect(onDisc).not.toBeNull();
    onDisc!();
    await Promise.resolve();
    expect(protocol.disconnectedCount).toBe(1);
  });
});
