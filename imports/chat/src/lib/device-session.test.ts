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
import { DeviceSession } from './bluetooth';

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

function createMockServer(writeChar: MockCharacteristic, notifyChar: MockCharacteristic, batteryChar: MockCharacteristic) {
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
  readonly gatt: { connected: boolean; connect: () => Promise<unknown>; disconnect: ReturnType<typeof vi.fn> };
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

  it('rejects an unrecognized device name', async () => {
    const device = new MockDevice('SomeOtherBleThing', 'unknown-1');
    (navigator as unknown as { bluetooth?: unknown }).bluetooth = mockBluetoothQueue([device]);

    const session = new DeviceSession();
    await expect(session.connectDevice()).rejects.toThrow(/未识别/);
  });

  it('replaces the previous sensor when a second sensor is added (v1: one sensor at a time)', async () => {
    const first = new MockDevice(`${PAW_PRINTS_DEVICE_NAME_PREFIX}000`, 'paw-1');
    const second = new MockDevice(`${CIVET_DEVICE_NAME_PREFIX}000`, 'civet-1');
    (navigator as unknown as { bluetooth?: unknown }).bluetooth = mockBluetoothQueue([first, second]);

    const session = new DeviceSession();
    await session.connectDevice();
    expect(session.getSensorSummary()?.kind).toBe('paw-prints');

    await session.connectDevice();
    expect(session.getSensorSummary()?.kind).toBe('civet-edging');
    expect(first.gatt.disconnect).toHaveBeenCalled();
  });

  it('disconnectSensor() clears the sensor slot without touching opossum', async () => {
    const sensor = new MockDevice(`${PAW_PRINTS_DEVICE_NAME_PREFIX}000`, 'paw-1');
    const opossum = new MockDevice(`${OPOSSUM_DEVICE_NAME_PREFIX}000`, 'opossum-1');
    (navigator as unknown as { bluetooth?: unknown }).bluetooth = mockBluetoothQueue([sensor, opossum]);

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
    (navigator as unknown as { bluetooth?: unknown }).bluetooth = mockBluetoothQueue([good, broken]);

    const session = new DeviceSession();
    await session.connectDevice();
    expect(session.getSensorSummary()?.kind).toBe('paw-prints');

    await expect(session.connectDevice()).rejects.toThrow();

    expect(session.getSensorSummary()?.kind).toBe('paw-prints');
    expect(session.getSensorSummary()?.connected).toBe(true);
    expect(good.gatt.disconnect).not.toHaveBeenCalled();
  });
});
