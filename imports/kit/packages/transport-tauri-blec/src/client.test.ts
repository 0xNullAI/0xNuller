import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TauriBlecDeviceClient, type DiscoveredDevice } from './client.js';
import { __setPluginBlecForTests, type BleDeviceInfo } from './plugin-blec.js';
import { requestDgLabDeviceTauri } from './request-device.js';
import { makeApi, makeDevice } from './test-utils.js';

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
  public emergencyStopCount = 0;
  async emergencyStop(): Promise<void> {
    this.emergencyStopCount += 1;
  }
  async setLimits(_a: number, _b: number): Promise<void> {
    return;
  }
}

afterEach(() => __setPluginBlecForTests(undefined));

describe('TauriBlecDeviceClient.connect', () => {
  it('checks permissions, scans, lets UI pick, then connects', async () => {
    const api = makeApi({
      startScan: vi.fn().mockImplementation(async (handler: (devices: BleDeviceInfo[]) => void) => {
        // simulate plugin-blec emitting device immediately
        setTimeout(() => handler([makeDevice()]), 5);
      }),
    });
    __setPluginBlecForTests(api);

    const protocol = new FakeProtocol();
    const selectDevice = vi
      .fn()
      .mockImplementation(
        async (controller: {
          initial: DiscoveredDevice[];
          subscribe: (h: (d: DiscoveredDevice[]) => void) => () => void;
        }) => {
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
      startScan: vi.fn().mockImplementation(async (handler: (devices: BleDeviceInfo[]) => void) => {
        setTimeout(() => handler([makeDevice()]), 5);
      }),
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
      startScan: vi.fn().mockImplementation(async (handler: (devices: BleDeviceInfo[]) => void) => {
        setTimeout(
          () =>
            handler([
              makeDevice({ address: 'A', name: '47L1210000XX' }),
              makeDevice({ address: 'B', name: 'AirPods' }),
              makeDevice({ address: 'C', name: 'D-LAB ESTIM01' }),
            ]),
          5,
        );
      }),
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

  it('disconnect() zeroes the device via emergencyStop before tearing down BLE', async () => {
    const protocolEmergencyStop = vi.fn().mockResolvedValue(undefined);
    const api = makeApi({
      startScan: vi.fn().mockImplementation(async (handler: (devices: BleDeviceInfo[]) => void) => {
        setTimeout(() => handler([makeDevice()]), 5);
      }),
    });
    __setPluginBlecForTests(api);
    const protocol = new FakeProtocol();
    protocol.emergencyStop = protocolEmergencyStop;
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

    await client.disconnect();
    expect(protocolEmergencyStop).toHaveBeenCalledTimes(1);
    // Address must be passed explicitly — the address-less overload now
    // throws AmbiguousDevice once a second device is connected elsewhere.
    expect(api.disconnect).toHaveBeenCalledWith('AA:BB:CC');
    // emergencyStop must run before plugin-blec.disconnect.
    const stopOrder = protocolEmergencyStop.mock.invocationCallOrder[0]!;
    const disconnectOrder = (api.disconnect as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0]!;
    expect(stopOrder).toBeLessThan(disconnectOrder);
  });

  it('rejects a second connect() while the first is still running', async () => {
    let releaseFirstSelect: ((address: string | null) => void) | null = null;
    const api = makeApi({
      startScan: vi.fn().mockImplementation(async (handler: (devices: BleDeviceInfo[]) => void) => {
        setTimeout(() => handler([makeDevice()]), 5);
      }),
    });
    __setPluginBlecForTests(api);

    const protocol = new FakeProtocol();
    const client = new TauriBlecDeviceClient({
      protocol: protocol as never,
      selectDevice: () =>
        new Promise<string | null>((resolve) => {
          releaseFirstSelect = resolve;
        }),
      scanDurationMs: 50,
      gattReadyInitialDelayMs: 0,
    });

    const first = client.connect();
    // Yield so the first call enters selectDevice and parks.
    await new Promise((r) => setTimeout(r, 10));

    await expect(client.connect()).rejects.toThrow(/连接中/);

    // Release the first call so the test cleans up tidily.
    releaseFirstSelect!(null);
    await expect(first).rejects.toThrow(/取消/);
  });

  it('rejects connect() when the client is already connected', async () => {
    const api = makeApi({
      startScan: vi.fn().mockImplementation(async (handler: (devices: BleDeviceInfo[]) => void) => {
        setTimeout(() => handler([makeDevice()]), 5);
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
      gattReadyInitialDelayMs: 0,
    });
    await client.connect();
    await expect(client.connect()).rejects.toThrow(/已连接/);
  });

  it('retries protocol.onConnected through a transient GATT-not-ready error', async () => {
    const api = makeApi({
      startScan: vi.fn().mockImplementation(async (handler: (devices: BleDeviceInfo[]) => void) => {
        setTimeout(() => handler([makeDevice()]), 5);
      }),
    });
    __setPluginBlecForTests(api);

    const protocol = new FakeProtocol();
    let calls = 0;
    protocol.onConnected = async (context: { device: { name?: string } }) => {
      calls += 1;
      if (calls < 3) {
        throw new Error('No services matching UUID 0000180c-0000-1000-8000-00805f9b34fb');
      }
      (protocol as FakeProtocol).connectedContext = { deviceName: context.device.name ?? '' };
    };

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
      gattReadyInitialDelayMs: 0,
      gattReadyIntervalMs: 5,
      gattReadyTimeoutMs: 500,
    });
    await client.connect();

    expect(calls).toBe(3);
    expect(protocol.connectedContext?.deviceName).toBe('47L1210000XX');
  });

  it('does not retry non-GATT errors from protocol.onConnected', async () => {
    const api = makeApi({
      startScan: vi.fn().mockImplementation(async (handler: (devices: BleDeviceInfo[]) => void) => {
        setTimeout(() => handler([makeDevice()]), 5);
      }),
    });
    __setPluginBlecForTests(api);

    const protocol = new FakeProtocol();
    let calls = 0;
    protocol.onConnected = async () => {
      calls += 1;
      throw new Error('protocol handshake invalid');
    };

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
      gattReadyInitialDelayMs: 0,
      gattReadyIntervalMs: 5,
      gattReadyTimeoutMs: 500,
    });
    await expect(client.connect()).rejects.toThrow(/protocol handshake invalid/);
    expect(calls).toBe(1);
    expect(api.disconnect).toHaveBeenCalled();
  });

  it('surfaces the last GATT-not-ready error when the retry budget elapses', async () => {
    const api = makeApi({
      startScan: vi.fn().mockImplementation(async (handler: (devices: BleDeviceInfo[]) => void) => {
        setTimeout(() => handler([makeDevice()]), 5);
      }),
    });
    __setPluginBlecForTests(api);

    const protocol = new FakeProtocol();
    protocol.onConnected = async () => {
      throw new Error('Service not found: 0000180c');
    };

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
      gattReadyInitialDelayMs: 0,
      gattReadyIntervalMs: 5,
      gattReadyTimeoutMs: 25,
    });
    await expect(client.connect()).rejects.toThrow(/Service not found/);
    expect(api.disconnect).toHaveBeenCalled();
  });

  it('disconnect callback from plugin-blec triggers protocol.onDisconnected', async () => {
    let onDisc: (() => void) | null = null;
    const api = makeApi({
      startScan: vi.fn().mockImplementation(async (handler: (devices: BleDeviceInfo[]) => void) => {
        setTimeout(() => handler([makeDevice()]), 5);
      }),
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

describe('TauriBlecDeviceClient auto-reconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Scan handlers fire synchronously (no setTimeout) in this block so
  // client.connect() resolves without needing to advance fake timers —
  // only the reconnect backoff below is timer-driven.
  function selectFirstDevice(controller: {
    initial: DiscoveredDevice[];
    subscribe: (h: (d: DiscoveredDevice[]) => void) => () => void;
  }): Promise<string | null> {
    return Promise.resolve(controller.initial[0]?.address ?? null);
  }

  it('without autoReconnect, a passive plugin-blec disconnect does not retry', async () => {
    let onDisc: (() => void) | null = null;
    const api = makeApi({
      startScan: vi.fn().mockImplementation(async (handler: (devices: BleDeviceInfo[]) => void) => {
        handler([makeDevice()]);
      }),
      connect: vi.fn().mockImplementation(async (_addr: string, cb: () => void) => {
        onDisc = cb;
      }),
    });
    __setPluginBlecForTests(api);
    const protocol = new FakeProtocol();
    const client = new TauriBlecDeviceClient({
      protocol: protocol as never,
      selectDevice: selectFirstDevice,
      scanDurationMs: 50,
      gattReadyInitialDelayMs: 0,
    });

    await client.connect();
    expect(api.connect).toHaveBeenCalledTimes(1);

    onDisc!();
    await vi.runAllTimersAsync();

    expect(protocol.disconnectedCount).toBe(1);
    expect(api.connect).toHaveBeenCalledTimes(1); // no reconnect attempt
  });

  it('with autoReconnect, silently reconnects to the last address after a passive disconnect', async () => {
    let onDisc: (() => void) | null = null;
    const api = makeApi({
      startScan: vi.fn().mockImplementation(async (handler: (devices: BleDeviceInfo[]) => void) => {
        handler([makeDevice()]);
      }),
      connect: vi.fn().mockImplementation(async (_addr: string, cb: () => void) => {
        onDisc = cb;
      }),
    });
    __setPluginBlecForTests(api);
    const protocol = new FakeProtocol();
    const reconnectStates: string[] = [];
    const client = new TauriBlecDeviceClient({
      protocol: protocol as never,
      selectDevice: selectFirstDevice,
      scanDurationMs: 50,
      gattReadyInitialDelayMs: 0,
      autoReconnect: true,
      reconnectBackoffMs: [100],
      onReconnectStateChange: (s) => reconnectStates.push(s),
    });

    await client.connect();
    expect(api.connect).toHaveBeenCalledTimes(1);
    expect(api.connect).toHaveBeenCalledWith('AA:BB:CC', expect.any(Function));

    onDisc!();
    await vi.advanceTimersByTimeAsync(150);

    expect(reconnectStates).toEqual(['reconnecting', 'reconnected']);
    expect(api.connect).toHaveBeenCalledTimes(2);
    expect(api.connect).toHaveBeenLastCalledWith('AA:BB:CC', expect.any(Function));
    // Reconnect must skip scanning / the chooser flow entirely.
    expect(api.startScan).toHaveBeenCalledTimes(1);
  });

  it('after exhausting reconnect attempts, emits failed and stops retrying', async () => {
    let onDisc: (() => void) | null = null;
    let connectCalls = 0;
    const api = makeApi({
      startScan: vi.fn().mockImplementation(async (handler: (devices: BleDeviceInfo[]) => void) => {
        handler([makeDevice()]);
      }),
      connect: vi.fn().mockImplementation(async (_addr: string, cb: () => void) => {
        connectCalls += 1;
        onDisc = cb;
        if (connectCalls > 1) {
          throw new Error('connect refused');
        }
      }),
    });
    __setPluginBlecForTests(api);
    const protocol = new FakeProtocol();
    const reconnectStates: string[] = [];
    const client = new TauriBlecDeviceClient({
      protocol: protocol as never,
      selectDevice: selectFirstDevice,
      scanDurationMs: 50,
      gattReadyInitialDelayMs: 0,
      autoReconnect: true,
      reconnectAttempts: 2,
      reconnectBackoffMs: [10, 10],
      onReconnectStateChange: (s) => reconnectStates.push(s),
    });

    await client.connect();
    onDisc!();
    await vi.advanceTimersByTimeAsync(200);

    expect(reconnectStates).toEqual(['reconnecting', 'reconnecting', 'failed']);
    expect(connectCalls).toBe(3); // initial connect + 2 retries
  });

  it('a user-initiated disconnect() cancels a scheduled reconnect and is never followed by one', async () => {
    let onDisc: (() => void) | null = null;
    const api = makeApi({
      startScan: vi.fn().mockImplementation(async (handler: (devices: BleDeviceInfo[]) => void) => {
        handler([makeDevice()]);
      }),
      connect: vi.fn().mockImplementation(async (_addr: string, cb: () => void) => {
        onDisc = cb;
      }),
    });
    __setPluginBlecForTests(api);
    const protocol = new FakeProtocol();
    const reconnectStates: string[] = [];
    const client = new TauriBlecDeviceClient({
      protocol: protocol as never,
      selectDevice: selectFirstDevice,
      scanDurationMs: 50,
      gattReadyInitialDelayMs: 0,
      autoReconnect: true,
      reconnectBackoffMs: [50],
      onReconnectStateChange: (s) => reconnectStates.push(s),
    });

    await client.connect();
    // Simulate an unexpected drop; this schedules (but doesn't yet run) a
    // reconnect attempt.
    onDisc!();
    expect(reconnectStates).toEqual(['reconnecting']);

    await client.disconnect();
    await vi.advanceTimersByTimeAsync(200);

    // The scheduled attempt must never fire after a manual disconnect.
    expect(reconnectStates).toEqual(['reconnecting']);
    expect(api.connect).toHaveBeenCalledTimes(1);
  });

  it('rejects a manual connect() while a reconnect attempt is actively in flight', async () => {
    let onDisc: (() => void) | null = null;
    let resolveSecondConnect: (() => void) | null = null;
    let connectCalls = 0;
    const api = makeApi({
      startScan: vi.fn().mockImplementation(async (handler: (devices: BleDeviceInfo[]) => void) => {
        handler([makeDevice()]);
      }),
      connect: vi.fn().mockImplementation(async (_addr: string, cb: () => void) => {
        connectCalls += 1;
        onDisc = cb;
        if (connectCalls === 2) {
          // Hold the reconnect's plugin-blec.connect() open so we can
          // exercise the reentrancy guard while it's mid-flight.
          await new Promise<void>((resolve) => {
            resolveSecondConnect = resolve;
          });
        }
      }),
    });
    __setPluginBlecForTests(api);
    const protocol = new FakeProtocol();
    const client = new TauriBlecDeviceClient({
      protocol: protocol as never,
      selectDevice: selectFirstDevice,
      scanDurationMs: 50,
      gattReadyInitialDelayMs: 0,
      autoReconnect: true,
      reconnectBackoffMs: [10],
    });

    await client.connect();
    onDisc!();
    // Let the reconnect timer fire and enter plugin-blec.connect(), where
    // it's now held open by the mock.
    await vi.advanceTimersByTimeAsync(20);

    await expect(client.connect()).rejects.toThrow(/连接中/);

    resolveSecondConnect!();
    await vi.advanceTimersByTimeAsync(50);
  });

  it('disconnect() during an in-flight reconnect tears the freshly-reconnected link back down', async () => {
    let onDisc: (() => void) | null = null;
    let resolveSecondConnect: (() => void) | null = null;
    let connectCalls = 0;
    const api = makeApi({
      startScan: vi.fn().mockImplementation(async (handler: (devices: BleDeviceInfo[]) => void) => {
        handler([makeDevice()]);
      }),
      connect: vi.fn().mockImplementation(async (_addr: string, cb: () => void) => {
        connectCalls += 1;
        onDisc = cb;
        if (connectCalls === 2) {
          await new Promise<void>((resolve) => {
            resolveSecondConnect = resolve;
          });
        }
      }),
    });
    __setPluginBlecForTests(api);
    const protocol = new FakeProtocol();
    const reconnectStates: string[] = [];
    const client = new TauriBlecDeviceClient({
      protocol: protocol as never,
      selectDevice: selectFirstDevice,
      scanDurationMs: 50,
      gattReadyInitialDelayMs: 0,
      autoReconnect: true,
      reconnectBackoffMs: [10],
      onReconnectStateChange: (s) => reconnectStates.push(s),
    });

    await client.connect();
    onDisc!();
    await vi.advanceTimersByTimeAsync(20); // reconnect attempt now in flight

    await client.disconnect();
    // disconnect() can't abort the already-started plugin-blec.connect()
    // call, only cancel a pending timer — so 'reconnected' must never be
    // emitted, and once the held connect() resolves, tryReconnect must
    // detect the manual disconnect and tear the link back down itself.
    resolveSecondConnect!();
    await vi.advanceTimersByTimeAsync(50);

    expect(reconnectStates).toEqual(['reconnecting']);
    expect(api.disconnect).toHaveBeenCalled();
    // forceTeardown() must zero the device before severing the link — same
    // safety requirement as a normal disconnect() — otherwise a user who
    // disconnects mid-reconnect could leave the device running at its last
    // commanded strength with no way to remotely stop it.
    expect(protocol.emergencyStopCount).toBeGreaterThan(0);
  });
});

describe('TauriBlecDeviceClient concurrent multi-device connections', () => {
  // Both clients share the same underlying plugin-blec stub — realistic,
  // since the native plugin is a single module tracking several addresses
  // concurrently, not one instance per JS client.
  function selectAddress(address: string) {
    return async (controller: {
      initial: DiscoveredDevice[];
      subscribe: (h: (d: DiscoveredDevice[]) => void) => () => void;
    }) => {
      const devices = await new Promise<DiscoveredDevice[]>((resolve) => {
        if (controller.initial.length) return resolve(controller.initial);
        const off = controller.subscribe((next) => {
          if (next.length) {
            off();
            resolve(next);
          }
        });
      });
      const match = devices.find((d) => d.address === address);
      return match?.address ?? null;
    };
  }

  it('two clients connect to different addresses concurrently without stepping on each other', async () => {
    const api = makeApi({
      startScan: vi.fn().mockImplementation(async (handler: (devices: BleDeviceInfo[]) => void) => {
        setTimeout(
          () =>
            handler([
              makeDevice({ address: 'COYOTE-ADDR', name: '47L1210000XX' }),
              makeDevice({ address: 'OPOSSUM-ADDR', name: '47L1270000XX' }),
            ]),
          5,
        );
      }),
    });
    __setPluginBlecForTests(api);

    const protocolA = new FakeProtocol();
    const protocolB = new FakeProtocol();
    const clientA = new TauriBlecDeviceClient({
      protocol: protocolA as never,
      selectDevice: selectAddress('COYOTE-ADDR'),
      scanDurationMs: 50,
      gattReadyInitialDelayMs: 0,
    });
    const clientB = new TauriBlecDeviceClient({
      protocol: protocolB as never,
      selectDevice: selectAddress('OPOSSUM-ADDR'),
      scanDurationMs: 50,
      gattReadyInitialDelayMs: 0,
    });

    await Promise.all([clientA.connect(), clientB.connect()]);

    expect(clientA.address).toBe('COYOTE-ADDR');
    expect(clientB.address).toBe('OPOSSUM-ADDR');
    expect(protocolA.connectedContext?.deviceName).toBe('47L1210000XX');
    expect(protocolB.connectedContext?.deviceName).toBe('47L1270000XX');
    expect(api.connect).toHaveBeenCalledWith('COYOTE-ADDR', expect.any(Function));
    expect(api.connect).toHaveBeenCalledWith('OPOSSUM-ADDR', expect.any(Function));
  });

  it('disconnecting one client does not disconnect or affect the other', async () => {
    const api = makeApi({
      startScan: vi.fn().mockImplementation(async (handler: (devices: BleDeviceInfo[]) => void) => {
        handler([
          makeDevice({ address: 'COYOTE-ADDR', name: '47L1210000XX' }),
          makeDevice({ address: 'OPOSSUM-ADDR', name: '47L1270000XX' }),
        ]);
      }),
    });
    __setPluginBlecForTests(api);

    const protocolA = new FakeProtocol();
    const protocolB = new FakeProtocol();
    const clientA = new TauriBlecDeviceClient({
      protocol: protocolA as never,
      selectDevice: selectAddress('COYOTE-ADDR'),
      scanDurationMs: 50,
      gattReadyInitialDelayMs: 0,
    });
    const clientB = new TauriBlecDeviceClient({
      protocol: protocolB as never,
      selectDevice: selectAddress('OPOSSUM-ADDR'),
      scanDurationMs: 50,
      gattReadyInitialDelayMs: 0,
    });

    await clientA.connect();
    await clientB.connect();

    await clientA.disconnect();

    expect(api.disconnect).toHaveBeenCalledTimes(1);
    expect(api.disconnect).toHaveBeenCalledWith('COYOTE-ADDR');
    expect(protocolA.disconnectedCount).toBe(1);
    // clientB was never touched: no disconnect call for its address, no
    // onDisconnected() signal to its protocol.
    expect(protocolB.disconnectedCount).toBe(0);
    expect(clientB.address).toBe('OPOSSUM-ADDR');
  });
});

describe('TauriBlecDeviceClient.connectDevice', () => {
  it('attaches an already-connected (device, server) pair from a unified picker instead of scanning', async () => {
    const api = makeApi({
      startScan: vi.fn().mockImplementation(async (handler: (devices: BleDeviceInfo[]) => void) => {
        handler([makeDevice({ address: 'COYOTE-1', name: '47L1210000XX' })]);
      }),
    });
    __setPluginBlecForTests(api);

    const picked = await requestDgLabDeviceTauri({
      selectDevice: async (c) => c.initial[0]?.address ?? null,
      scanDurationMs: 50,
    });
    expect(picked.kind).toBe('coyote');
    (api.startScan as ReturnType<typeof vi.fn>).mockClear();
    (api.connect as ReturnType<typeof vi.fn>).mockClear();

    const protocol = new FakeProtocol();
    const client = new TauriBlecDeviceClient({
      protocol: protocol as never,
      selectDevice: vi.fn(),
      gattReadyInitialDelayMs: 0,
    });
    await client.connectDevice(picked.device, picked.server);

    expect(client.address).toBe('COYOTE-1');
    expect(api.startScan).not.toHaveBeenCalled();
    // Attaching must not re-dial plugin-blec's connect(): the device is
    // already connected via the picker's own api.connect() call.
    expect(api.connect).not.toHaveBeenCalled();
    expect(protocol.connectedContext?.deviceName).toBe('47L1210000XX');
  });

  it('rejects connectDevice() when already connected or a connect is in flight', async () => {
    const api = makeApi({
      startScan: vi.fn().mockImplementation(async (handler: (devices: BleDeviceInfo[]) => void) => {
        handler([makeDevice({ address: 'COYOTE-1', name: '47L1210000XX' })]);
      }),
    });
    __setPluginBlecForTests(api);

    const picked = await requestDgLabDeviceTauri({
      selectDevice: async (c) => c.initial[0]?.address ?? null,
      scanDurationMs: 50,
    });

    const protocol = new FakeProtocol();
    const client = new TauriBlecDeviceClient({
      protocol: protocol as never,
      selectDevice: vi.fn(),
      gattReadyInitialDelayMs: 0,
    });
    await client.connectDevice(picked.device, picked.server);

    await expect(client.connectDevice(picked.device, picked.server)).rejects.toThrow(/已连接/);
  });

  it('disconnect() after connectDevice() tears down cleanly, calling onDisconnected exactly once', async () => {
    const api = makeApi({
      startScan: vi.fn().mockImplementation(async (handler: (devices: BleDeviceInfo[]) => void) => {
        handler([makeDevice({ address: 'COYOTE-1', name: '47L1210000XX' })]);
      }),
    });
    __setPluginBlecForTests(api);

    const picked = await requestDgLabDeviceTauri({
      selectDevice: async (c) => c.initial[0]?.address ?? null,
      scanDurationMs: 50,
    });

    const protocol = new FakeProtocol();
    const client = new TauriBlecDeviceClient({
      protocol: protocol as never,
      selectDevice: vi.fn(),
      gattReadyInitialDelayMs: 0,
    });
    await client.connectDevice(picked.device, picked.server);

    await client.disconnect();

    expect(client.address).toBeNull();
    expect(picked.device.gatt!.connected).toBe(false);
    // The passthrough listener wiring must not cause onDisconnected() to
    // fire twice (once from disconnect()'s own call, once more from the
    // gattserverdisconnected event disconnect() itself triggers via the
    // shim's gatt.disconnect()).
    expect(protocol.disconnectedCount).toBe(1);
  });

  it('an unexpected drop after connectDevice() (gattserverdisconnected fired externally) reaches protocol.onDisconnected()', async () => {
    const api = makeApi({
      startScan: vi.fn().mockImplementation(async (handler: (devices: BleDeviceInfo[]) => void) => {
        handler([makeDevice({ address: 'COYOTE-1', name: '47L1210000XX' })]);
      }),
    });
    __setPluginBlecForTests(api);

    const picked = await requestDgLabDeviceTauri({
      selectDevice: async (c) => c.initial[0]?.address ?? null,
      scanDurationMs: 50,
    });

    const protocol = new FakeProtocol();
    const client = new TauriBlecDeviceClient({
      protocol: protocol as never,
      selectDevice: vi.fn(),
      gattReadyInitialDelayMs: 0,
    });
    await client.connectDevice(picked.device, picked.server);

    // Simulate an out-of-range drop: the picker's own shim fires the DOM
    // event when plugin-blec signals a disconnect for this address.
    picked.device.gatt!.disconnect();

    expect(client.address).toBeNull();
    expect(protocol.disconnectedCount).toBe(1);
  });
});
