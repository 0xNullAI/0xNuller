import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  V3_BATTERY_CHAR,
  V3_BATTERY_SERVICE,
  V3_NOTIFY_CHAR,
  V3_PRIMARY_SERVICE,
  V3_WRITE_CHAR,
  PAW_PRINTS_DEVICE_NAME_PREFIX,
  CIVET_DEVICE_NAME_PREFIX,
  OPOSSUM_DEVICE_NAME_PREFIX,
  V3_DEVICE_NAME_PREFIX,
} from '@dg-kit/protocol';
import { DeviceSession, type RequestDeviceFn } from './bluetooth';

/**
 * Minimal Web Bluetooth mocks, mirroring the pattern DG-Kit's own adapter
 * tests use (see packages/protocol/src/opossum.test.ts) — a fake
 * characteristic that records writes and can be told to emit a
 * notification, and a fake GATT server that serves the shared V3 skeleton
 * (service 0x180C, write 0x150A, notify 0x150B, battery 0x180A/0x1500) that
 * every 47L12x-family device (paw-prints/civet-edging/opossum) shares.
 */
class MockCharacteristic extends EventTarget {
  value: DataView | null = null;
  private readonly onWrite?: (value: Uint8Array) => void;

  constructor(onWrite?: (value: Uint8Array) => void) {
    super();
    this.onWrite = onWrite;
  }

  async writeValueWithoutResponse(value: ArrayBufferView | ArrayBuffer): Promise<void> {
    const buffer =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    this.onWrite?.(new Uint8Array(buffer));
  }

  async readValue(): Promise<DataView> {
    return new DataView(new Uint8Array([88]).buffer);
  }

  async startNotifications(): Promise<MockCharacteristic> {
    return this;
  }

  async stopNotifications(): Promise<MockCharacteristic> {
    return this;
  }

  emitNotification(bytes: number[]): void {
    this.value = new DataView(new Uint8Array(bytes).buffer);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}

function createMockServer(
  writeChar: MockCharacteristic,
  notifyChar: MockCharacteristic,
  batteryChar: MockCharacteristic,
) {
  return {
    connected: true,
    async getPrimaryService(service: string) {
      if (service === V3_PRIMARY_SERVICE) {
        return {
          async getCharacteristic(characteristic: string) {
            if (characteristic === V3_WRITE_CHAR) return writeChar;
            if (characteristic === V3_NOTIFY_CHAR) return notifyChar;
            throw new Error(`unknown characteristic: ${characteristic}`);
          },
        };
      }
      if (service === V3_BATTERY_SERVICE) {
        return {
          async getCharacteristic(characteristic: string) {
            if (characteristic === V3_BATTERY_CHAR) return batteryChar;
            throw new Error(`unknown characteristic: ${characteristic}`);
          },
        };
      }
      throw new Error(`unknown service: ${service}`);
    },
  };
}

/** A fake `BluetoothDevice` — real EventTarget so gattserverdisconnected wiring is exercised for real. */
class MockDevice extends EventTarget {
  readonly gatt: {
    connected: boolean;
    connect: () => Promise<unknown>;
    disconnect: ReturnType<typeof vi.fn>;
  };
  name: string;
  id: string;
  writeChar = new MockCharacteristic((bytes) => this.writes.push(Array.from(bytes)));
  notifyChar = new MockCharacteristic();
  batteryChar = new MockCharacteristic();
  writes: number[][] = [];

  constructor(name: string, id: string) {
    super();
    this.name = name;
    this.id = id;
    const server = createMockServer(this.writeChar, this.notifyChar, this.batteryChar);
    this.gatt = {
      connected: true,
      connect: async () => server,
      disconnect: vi.fn(),
    };
  }
}

function mockBluetoothQueue(devices: MockDevice[]) {
  let index = 0;
  return {
    requestDevice: vi.fn(async () => {
      const device = devices[index];
      index += 1;
      if (!device) throw new Error('no more mock devices queued');
      return device;
    }),
  };
}

describe('DeviceSession — multi-device routing', () => {
  let originalBluetooth: unknown;

  beforeEach(() => {
    originalBluetooth = (navigator as unknown as { bluetooth?: unknown }).bluetooth;
  });

  afterEach(() => {
    (navigator as unknown as { bluetooth?: unknown }).bluetooth = originalBluetooth;
  });

  it('同一会话一次只允许一个连接流程，避免两个入口同时抢同一个槽位', async () => {
    const device = new MockDevice(`${V3_DEVICE_NAME_PREFIX}000`, 'coyote-1');
    const server = await device.gatt.connect();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requestDevice = vi.fn(async () => {
      await gate;
      return { kind: 'coyote' as const, device, server: server as never };
    });
    const session = new DeviceSession(undefined, requestDevice as RequestDeviceFn);

    const first = session.connectDevice();
    await expect(session.connectDevice()).rejects.toThrow('正在连接中');
    expect(requestDevice).toHaveBeenCalledTimes(1);

    release();
    await first;
    expect(session.getCoyoteSummaries()).toHaveLength(1);
  });

  it('routes a paw-prints-prefixed device name to the sensor slot', async () => {
    const device = new MockDevice(`${PAW_PRINTS_DEVICE_NAME_PREFIX}000`, 'paw-1');
    (navigator as unknown as { bluetooth?: unknown }).bluetooth = mockBluetoothQueue([device]);

    const session = new DeviceSession();
    const result = await session.connectDevice();

    expect(result.kind).toBe('paw-prints');
    const summary = session.getSensorSummary();
    expect(summary?.kind).toBe('paw-prints');
    expect(summary?.connected).toBe(true);
    expect(session.getOpossumSummary()).toBeNull();
  });

  it('routes a civet-edging-prefixed device name to the sensor slot and surfaces pressure readings', async () => {
    const device = new MockDevice(`${CIVET_DEVICE_NAME_PREFIX}000`, 'civet-1');
    (navigator as unknown as { bluetooth?: unknown }).bluetooth = mockBluetoothQueue([device]);

    const session = new DeviceSession();
    const result = await session.connectDevice();
    expect(result.kind).toBe('civet-edging');

    // 0xD0 pressure notification, signed int16 LE at offset 8-9, centi-kPa.
    // 1234 centi-kPa = 12.34 kPa. Bytes: [0xd0, 0,0,0,0,0,0,0, lo, hi]
    const bytes = new Array(10).fill(0);
    bytes[0] = 0xd0;
    const view = new DataView(new ArrayBuffer(2));
    view.setInt16(0, 1234, true);
    bytes[8] = view.getUint8(0);
    bytes[9] = view.getUint8(1);
    device.notifyChar.emitNotification(bytes);

    const summary = session.getSensorSummary();
    expect(summary?.lastValue).toBeCloseTo(12.34, 2);
    expect(summary?.lastEvent).toContain('kPa');
    expect(summary?.lastEventAt).not.toBeNull();
  });

  it('routes an opossum-prefixed device name to the opossum slot and supports intensity control', async () => {
    const device = new MockDevice(`${OPOSSUM_DEVICE_NAME_PREFIX}000`, 'opossum-1');
    (navigator as unknown as { bluetooth?: unknown }).bluetooth = mockBluetoothQueue([device]);

    const session = new DeviceSession();
    const result = await session.connectDevice();
    expect(result.kind).toBe('opossum');
    expect(session.getOpossumSummary()?.connected).toBe(true);

    session.setOpossumIntensity('A', 999, 50); // clamps to the passed-in limit (50), not the device max (200)
    // setIntensity is async; flush the event loop so the write + state update land.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.getOpossumSummary()?.intensityA).toBe(50);

    session.opossumStop();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.getOpossumSummary()?.intensityA).toBe(0);
    expect(session.getOpossumSummary()?.intensityB).toBe(0);
  });

  it('routes a Coyote-prefixed device pick to coyote.connectViaChosenDevice() instead of rejecting it', async () => {
    // Regression coverage for the unified connectDevice() entry point: a
    // Coyote pick through the shared chooser used to be rejected outright
    // (see the old "连接" vs "添加设备" split) — it must now connect through
    // DGLabDevice's own lifecycle via WebBluetoothDeviceClient.connectDevice().
    const device = new MockDevice(`${V3_DEVICE_NAME_PREFIX}000`, 'coyote-1');
    (navigator as unknown as { bluetooth?: unknown }).bluetooth = mockBluetoothQueue([device]);

    const session = new DeviceSession();
    const result = await session.connectDevice();

    expect(result.kind).toBe('coyote');
    expect(session.coyote.getState().connected).toBe(true);
    // Default 50 safety cap still applies via the shared connectViaChosenDevice()/
    // connect() bookkeeping in DGLabDevice.
    expect(session.coyote.getState().limitA).toBe(50);
    expect(session.coyote.getState().limitB).toBe(50);
    expect(device.gatt.disconnect).not.toHaveBeenCalled();
  });

  it('重复选择已连接的郊狼会保留现有连接，而不是把它断掉', async () => {
    const device = new MockDevice(`${V3_DEVICE_NAME_PREFIX}000`, 'coyote-1');
    (navigator as unknown as { bluetooth?: unknown }).bluetooth = mockBluetoothQueue([
      device,
      device,
    ]);

    const session = new DeviceSession();
    await session.connectDevice();
    await expect(session.connectDevice()).rejects.toThrow('设备已连接');

    expect(session.getCoyoteSummaries()).toHaveLength(1);
    expect(session.coyote.getState().connected).toBe(true);
    expect(device.gatt.disconnect).not.toHaveBeenCalled();
  });

  it('rejects an unrecognized device name', async () => {
    const device = new MockDevice('SomeOtherBleThing', 'unknown-1');
    (navigator as unknown as { bluetooth?: unknown }).bluetooth = mockBluetoothQueue([device]);

    const session = new DeviceSession();
    await expect(session.connectDevice()).rejects.toThrow(/未识别/);
  });

  it('replaces the previous sensor when a second sensor is added (v1: one sensor at a time)', async () => {
    const first = new MockDevice(`${PAW_PRINTS_DEVICE_NAME_PREFIX}000`, 'paw-1');
    const second = new MockDevice(`${CIVET_DEVICE_NAME_PREFIX}000`, 'civet-1');
    (navigator as unknown as { bluetooth?: unknown }).bluetooth = mockBluetoothQueue([
      first,
      second,
    ]);

    const session = new DeviceSession();
    await session.connectDevice();
    expect(session.getSensorSummary()?.kind).toBe('paw-prints');

    await session.connectDevice();
    expect(session.getSensorSummary()?.kind).toBe('civet-edging');
    expect(first.gatt.disconnect).toHaveBeenCalled();
  });

  it('重复选择同一传感器不会在替换旧槽位时断掉自己', async () => {
    const device = new MockDevice(`${PAW_PRINTS_DEVICE_NAME_PREFIX}000`, 'paw-1');
    (navigator as unknown as { bluetooth?: unknown }).bluetooth = mockBluetoothQueue([
      device,
      device,
    ]);

    const session = new DeviceSession();
    await session.connectDevice();
    await expect(session.connectDevice()).rejects.toThrow('设备已连接');

    expect(session.getSensorSummary()?.connected).toBe(true);
    expect(device.gatt.disconnect).not.toHaveBeenCalled();
  });

  it('disconnectSensor() clears the sensor slot without touching opossum', async () => {
    const sensor = new MockDevice(`${PAW_PRINTS_DEVICE_NAME_PREFIX}000`, 'paw-1');
    const opossum = new MockDevice(`${OPOSSUM_DEVICE_NAME_PREFIX}000`, 'opossum-1');
    (navigator as unknown as { bluetooth?: unknown }).bluetooth = mockBluetoothQueue([
      sensor,
      opossum,
    ]);

    const session = new DeviceSession();
    await session.connectDevice();
    await session.connectDevice();
    expect(session.getSensorSummary()).not.toBeNull();
    expect(session.getOpossumSummary()).not.toBeNull();

    session.disconnectSensor();
    expect(session.getSensorSummary()).toBeNull();
    expect(session.getOpossumSummary()).not.toBeNull();
  });

  it('fires onStateChange whenever a device attaches, emits a reading, or disconnects', async () => {
    const device = new MockDevice(`${OPOSSUM_DEVICE_NAME_PREFIX}000`, 'opossum-1');
    (navigator as unknown as { bluetooth?: unknown }).bluetooth = mockBluetoothQueue([device]);

    const session = new DeviceSession();
    const onChange = vi.fn();
    session.setOnStateChange(onChange);

    await session.connectDevice();
    expect(onChange).toHaveBeenCalled();

    onChange.mockClear();
    session.disconnectOpossum();
    expect(onChange).toHaveBeenCalled();
    expect(session.getOpossumSummary()).toBeNull();
  });

  it('defaults the shared 50 safety limit even when only an Opossum is connected (Coyote never connects)', async () => {
    // Regression: limitA/limitB used to be read straight from the Coyote
    // protocol's raw internal state, which @dg-kit/core defaults to 200
    // until DGLabDevice.connect() actually runs setLimits(50, 50) — so an
    // Opossum-only session (Coyote never connected) silently got the raw
    // 200 protocol max instead of the documented 50 default, for both local
    // control and remote vibrate_adjust/vibrate_burst commands.
    const device = new MockDevice(`${OPOSSUM_DEVICE_NAME_PREFIX}000`, 'opossum-1');
    (navigator as unknown as { bluetooth?: unknown }).bluetooth = mockBluetoothQueue([device]);

    const session = new DeviceSession();
    await session.connectDevice();

    const state = session.coyote.getState();
    expect(state.connected).toBe(false);
    expect(state.limitA).toBe(50);
    expect(state.limitB).toBe(50);
  });

  it('opossumBurst does not let its delayed restore clobber an intervening stop', async () => {
    vi.useFakeTimers();
    try {
      const device = new MockDevice(`${OPOSSUM_DEVICE_NAME_PREFIX}000`, 'opossum-1');
      (navigator as unknown as { bluetooth?: unknown }).bluetooth = mockBluetoothQueue([device]);

      const session = new DeviceSession();
      // connectDevice() now goes through runWithGattReadyRetry's default
      // 300ms initial delay (a real setTimeout, captured by fake timers) —
      // start the promise and pump the clock past it rather than awaiting
      // directly, or it hangs until vitest's own test timeout.
      const connecting = session.connectDevice();
      await vi.advanceTimersByTimeAsync(300);
      await connecting;

      session.opossumBurst('A', 160, 500, 200);
      await vi.advanceTimersByTimeAsync(0);
      expect(session.getOpossumSummary()?.intensityA).toBe(160);

      // Explicit stop lands well inside the burst's 500ms restore window.
      session.opossumStop('A');
      await vi.advanceTimersByTimeAsync(0);
      expect(session.getOpossumSummary()?.intensityA).toBe(0);

      // The stale burst-restore timer fires next — it must not undo the stop.
      await vi.advanceTimersByTimeAsync(500);
      expect(session.getOpossumSummary()?.intensityA).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('降低负鼠上限会立即归零，并约束之后的命令', async () => {
    const device = new MockDevice(`${OPOSSUM_DEVICE_NAME_PREFIX}000`, 'opossum-1');
    (navigator as unknown as { bluetooth?: unknown }).bluetooth = mockBluetoothQueue([device]);

    const session = new DeviceSession();
    await session.connectDevice();
    session.setOpossumIntensity('A', 40, 50);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.getOpossumSummary()?.intensityA).toBe(40);

    session.setOpossumLimits(20, 50);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.getOpossumSummary()?.intensityA).toBe(0);

    session.setOpossumIntensity('A', 50, 50);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.getOpossumSummary()?.intensityA).toBe(20);
  });

  it('keeps the previous sensor connected if swapping to a new one fails mid-handshake', async () => {
    // Regression: attachSensor()/attachOpossum() used to disconnect the
    // existing device BEFORE attempting the new one, so a flaky/wrong pick
    // during a swap lost the previously-good connection even though the
    // swap itself failed.
    const good = new MockDevice(`${PAW_PRINTS_DEVICE_NAME_PREFIX}000`, 'paw-1');
    const broken = new MockDevice(`${CIVET_DEVICE_NAME_PREFIX}000`, 'civet-broken');
    broken.gatt.connect = async () => ({
      connected: true,
      async getPrimaryService() {
        throw new Error('service discovery failed');
      },
    });
    (navigator as unknown as { bluetooth?: unknown }).bluetooth = mockBluetoothQueue([
      good,
      broken,
    ]);

    const session = new DeviceSession();
    await session.connectDevice();
    expect(session.getSensorSummary()?.kind).toBe('paw-prints');

    await expect(session.connectDevice()).rejects.toThrow();

    expect(session.getSensorSummary()?.kind).toBe('paw-prints');
    expect(session.getSensorSummary()?.connected).toBe(true);
    expect(good.gatt.disconnect).not.toHaveBeenCalled();
  });
});

/**
 * Several Coyote hosts attached to one session.
 *
 * These run against the real `DeviceSession` / `WebBluetoothDeviceClient` /
 * `CoyoteProtocolAdapter` / `DeviceCommandQueue` stack — only the GATT layer is
 * mocked — so what they assert is what actually goes out over the wire to each
 * device, not what a fake was told to record.
 */
describe('DeviceSession — 多台郊狼', () => {
  let originalBluetooth: unknown;

  beforeEach(() => {
    originalBluetooth = (navigator as unknown as { bluetooth?: unknown }).bluetooth;
  });

  afterEach(() => {
    (navigator as unknown as { bluetooth?: unknown }).bluetooth = originalBluetooth;
  });

  /** The V3 emergency-stop packet: absolute strength 0/0, [0xb0, 0x0f, 0, 0, ...]. */
  function sawEmergencyStop(device: MockDevice): boolean {
    return device.writes.some((w) => w[0] === 0xb0 && w[1] === 0x0f && w[2] === 0 && w[3] === 0);
  }

  async function connectTwoCoyotes() {
    const first = new MockDevice(`${V3_DEVICE_NAME_PREFIX}000`, 'coyote-1');
    const second = new MockDevice(`${V3_DEVICE_NAME_PREFIX}000`, 'coyote-2');
    (navigator as unknown as { bluetooth?: unknown }).bluetooth = mockBluetoothQueue([
      first,
      second,
    ]);
    const session = new DeviceSession();
    await session.connectDevice();
    await session.connectDevice();
    return { session, first, second };
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('两台可以同时连上，各自有自己的 id', async () => {
    const { session } = await connectTwoCoyotes();

    const summaries = session.getCoyoteSummaries();
    expect(summaries).toHaveLength(2);
    expect(summaries.map((c) => c.id).sort()).toEqual(['coyote-1', 'coyote-2']);
    expect(summaries.every((c) => c.connected)).toBe(true);
  });

  it('连第二台不会顶掉第一台', async () => {
    // The web transport used to disconnect the previously-held device on a
    // second connect. On a V3 (state-retentive across BLE drops) that left
    // device #1 running at its last commanded strength, unreachable.
    const { session, first } = await connectTwoCoyotes();

    expect(first.gatt.disconnect).not.toHaveBeenCalled();
    expect(session.coyoteById('coyote-1')?.getState().connected).toBe(true);
  });

  it('停止必须把每一台都归零，不只是主设备', async () => {
    // THE case this whole change turns on: the shell's global stop button
    // reaches exactly this function through the safety bus. A stop that
    // covered only the primary would leave the second device outputting while
    // the user believes they already stopped everything.
    const { session, first, second } = await connectTwoCoyotes();

    session.coyoteById('coyote-1')?.setStrength('A', 20);
    session.coyoteById('coyote-2')?.setStrength('B', 15);
    await flush();

    first.writes.length = 0;
    second.writes.length = 0;

    session.stopAllOutputs();
    await flush();

    // Physically observed on each device's own write characteristic.
    expect(sawEmergencyStop(first)).toBe(true);
    expect(sawEmergencyStop(second)).toBe(true);
    for (const summary of session.getCoyoteSummaries()) {
      expect(summary.strengthA).toBe(0);
      expect(summary.strengthB).toBe(0);
    }
  });

  it('断开其中一台，另一台照常连着并且还能被停止', async () => {
    const { session, first, second } = await connectTwoCoyotes();

    session.disconnectCoyote('coyote-1');
    await flush();

    const remaining = session.getCoyoteSummaries();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe('coyote-2');
    expect(first.gatt.disconnect).toHaveBeenCalled();

    second.writes.length = 0;
    session.stopAllOutputs();
    await flush();
    expect(sawEmergencyStop(second)).toBe(true);
  });

  it('不带 id 的断开会断掉每一台', async () => {
    const { session, first, second } = await connectTwoCoyotes();

    session.disconnectCoyote();
    await flush();

    expect(session.getCoyoteSummaries()).toHaveLength(0);
    expect(first.gatt.disconnect).toHaveBeenCalled();
    expect(second.gatt.disconnect).toHaveBeenCalled();
  });

  it('主设备断开后，标量口径跟着换到还连着的那台', async () => {
    const { session } = await connectTwoCoyotes();
    expect(session.coyote.id).toBe('coyote-1');

    session.disconnectCoyote('coyote-1');
    await flush();

    // If `coyote` stayed pinned to slot 0 it would now report "not connected"
    // while device #2 is still live on the user's body.
    expect(session.coyote.id).toBe('coyote-2');
    expect(session.coyote.getState().connected).toBe(true);
  });

  it('上限会落到每一台上，包括之后才连上的那台', async () => {
    const first = new MockDevice(`${V3_DEVICE_NAME_PREFIX}000`, 'coyote-1');
    const second = new MockDevice(`${V3_DEVICE_NAME_PREFIX}000`, 'coyote-2');
    (navigator as unknown as { bluetooth?: unknown }).bluetooth = mockBluetoothQueue([
      first,
      second,
    ]);

    const session = new DeviceSession();
    await session.connectDevice();
    // Lower the cap while only one host is attached...
    session.setCoyoteLimit('A', 30);
    // ...then attach a second. A cap the user lowered must not silently fail
    // to cover a device attached afterwards.
    await session.connectDevice();

    expect(session.getCoyoteSummaries().map((c) => c.limitA)).toEqual([30, 30]);
  });

  it('会用创建会话时的共享上限，而不是先短暂回到默认 50', async () => {
    const first = new MockDevice(`${V3_DEVICE_NAME_PREFIX}000`, 'coyote-1');
    const second = new MockDevice(`${V3_DEVICE_NAME_PREFIX}000`, 'coyote-2');
    (navigator as unknown as { bluetooth?: unknown }).bluetooth = mockBluetoothQueue([
      first,
      second,
    ]);

    const session = new DeviceSession(undefined, undefined, {
      strengthA: 17,
      strengthB: 23,
      intensityA: 19,
      intensityB: 29,
    });
    await session.connectDevice();
    await session.connectDevice();

    expect(session.getCoyoteSummaries().map((c) => [c.limitA, c.limitB])).toEqual([
      [17, 23],
      [17, 23],
    ]);
  });

  it('降低已连接主机的上限会作废旧命令并立即归零', async () => {
    const device = new MockDevice(`${V3_DEVICE_NAME_PREFIX}000`, 'coyote-1');
    (navigator as unknown as { bluetooth?: unknown }).bluetooth = mockBluetoothQueue([device]);
    const session = new DeviceSession();
    await session.connectDevice();
    await flush();

    session.coyote.setStrength('A', 20);
    await flush();
    expect(session.coyote.getState().strengthA).toBe(20);
    device.writes.length = 0;

    session.setCoyoteLimit('A', 10);
    await flush();

    expect(sawEmergencyStop(device)).toBe(true);
    expect(session.coyote.getState().strengthA).toBe(0);
    expect(session.coyote.getState().limitA).toBe(10);
  });

  it('两台各自钳各自的，不共用一份钳制状态', async () => {
    const { session } = await connectTwoCoyotes();

    session.coyoteById('coyote-1')?.setLimit('A', 10);
    session.coyoteById('coyote-2')?.setLimit('A', 40);

    const byId = new Map(session.getCoyoteSummaries().map((c) => [c.id, c]));
    expect(byId.get('coyote-1')?.limitA).toBe(10);
    expect(byId.get('coyote-2')?.limitA).toBe(40);
  });

  it('同一台设备重连时沿用原来的槽位，不会多出一行', async () => {
    const device = new MockDevice(`${V3_DEVICE_NAME_PREFIX}000`, 'coyote-1');
    (navigator as unknown as { bluetooth?: unknown }).bluetooth = {
      requestDevice: vi.fn(async () => device),
    };

    const session = new DeviceSession();
    await session.connectDevice();
    session.disconnectCoyote('coyote-1');
    await flush();

    await session.connectDevice();

    const summaries = session.getCoyoteSummaries();
    expect(summaries).toHaveLength(1);
    // Same identity across the drop — the device bar row and any targeted
    // command keep pointing at the same host.
    expect(summaries[0]?.id).toBe('coyote-1');
  });

  it('coyoteById 不带参数时给出主设备，给了未知 id 时给出 null', async () => {
    const { session } = await connectTwoCoyotes();

    // Omitted = primary. This is what every command sent by a client that
    // predates multi-device means, and Android has no hot update.
    expect(session.coyoteById()?.id).toBe('coyote-1');
    // An unknown id must not fall back to "some device" — that would let a
    // command meant for a device that is not here land on one that is.
    expect(session.coyoteById('not-attached')).toBeNull();
  });
});
