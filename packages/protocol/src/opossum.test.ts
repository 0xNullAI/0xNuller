import { describe, expect, it } from 'vitest';
import {
  V3_BATTERY_CHAR,
  V3_BATTERY_SERVICE,
  V3_NOTIFY_CHAR,
  V3_PRIMARY_SERVICE,
  V3_WRITE_CHAR,
} from './constants.js';
import { createEmptyOpossumState, OpossumVibrateAdapter } from './opossum.js';

// Minimal duplicate of protocol.test.ts's MockCharacteristic — kept local so
// this test file doesn't import across test files.
class MockCharacteristic extends EventTarget {
  value: DataView | null = null;

  constructor(private readonly onWrite?: (value: Uint8Array) => Promise<void> | void) {
    super();
  }

  async writeValueWithoutResponse(value: ArrayBufferView | ArrayBuffer): Promise<void> {
    const buffer =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    await this.onWrite?.(new Uint8Array(buffer));
  }

  async readValue(): Promise<DataView> {
    return new DataView(new Uint8Array([77]).buffer);
  }

  async startNotifications(): Promise<MockCharacteristic> {
    return this;
  }

  stopNotificationsCallCount = 0;
  async stopNotifications(): Promise<MockCharacteristic> {
    this.stopNotificationsCallCount += 1;
    return this;
  }

  /** Simulate the device pushing a notification on this characteristic. */
  emitNotification(bytes: number[]): void {
    this.value = new DataView(new Uint8Array(bytes).buffer);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}

function createMockServer(options: {
  writeChar: MockCharacteristic;
  notifyChar: MockCharacteristic;
  batteryChar?: MockCharacteristic | null;
  batteryUnavailable?: boolean;
}) {
  return {
    connected: true,
    async getPrimaryService(service: string) {
      if (service === V3_PRIMARY_SERVICE) {
        return {
          async getCharacteristic(characteristic: string) {
            if (characteristic === V3_WRITE_CHAR) return options.writeChar;
            if (characteristic === V3_NOTIFY_CHAR) return options.notifyChar;
            throw new Error(`unknown characteristic: ${characteristic}`);
          },
        };
      }
      if (service === V3_BATTERY_SERVICE) {
        if (options.batteryUnavailable) {
          throw new Error('battery service unavailable');
        }
        return {
          async getCharacteristic(characteristic: string) {
            if (characteristic === V3_BATTERY_CHAR && options.batteryChar) {
              return options.batteryChar;
            }
            throw new Error(`unknown characteristic: ${characteristic}`);
          },
        };
      }
      throw new Error(`unknown service: ${service}`);
    },
  };
}

async function connectAdapter(
  adapter: OpossumVibrateAdapter,
  overrides: {
    writeChar?: MockCharacteristic;
    notifyChar?: MockCharacteristic;
    batteryChar?: MockCharacteristic | null;
    batteryUnavailable?: boolean;
    deviceName?: string;
    deviceId?: string;
    writes?: number[][];
  } = {},
) {
  const writes: number[][] = overrides.writes ?? [];
  const writeChar =
    overrides.writeChar ??
    new MockCharacteristic((value) => {
      writes.push(Array.from(value));
    });
  const notifyChar = overrides.notifyChar ?? new MockCharacteristic();
  const batteryChar =
    overrides.batteryChar === undefined ? new MockCharacteristic() : overrides.batteryChar;

  const server = createMockServer({
    writeChar,
    notifyChar,
    batteryChar,
    batteryUnavailable: overrides.batteryUnavailable,
  });

  await adapter.onConnected({
    device: {
      name: overrides.deviceName ?? '47L127000',
      id: overrides.deviceId ?? 'opossum-device',
    } as unknown as EventTarget & { id?: string; name?: string },
    server,
  });

  return { writeChar, notifyChar, batteryChar, writes };
}

describe('createEmptyOpossumState', () => {
  it('matches the documented empty shape', () => {
    expect(createEmptyOpossumState()).toEqual({
      connected: false,
      battery: 0,
      intensityA: 0,
      intensityB: 0,
    });
  });
});

describe('OpossumVibrateAdapter packet builders', () => {
  it('builds 0xB3 direct-intensity packets matching the doc worked examples', async () => {
    const adapter = new OpossumVibrateAdapter();
    const { writes } = await connectAdapter(adapter);

    await adapter.setIntensity(160, 'unchanged');
    expect(writes.at(-1)).toEqual([0xb3, 0xa0, 0xff]);

    await adapter.setIntensity('unchanged', 200);
    expect(writes.at(-1)).toEqual([0xb3, 0xff, 0xc8]);

    await adapter.setIntensity(10, 20);
    expect(writes.at(-1)).toEqual([0xb3, 0x0a, 0x14]);
  });

  it('clamps out-of-range 0xB3 intensities to 0-200', async () => {
    const adapter = new OpossumVibrateAdapter();
    const { writes } = await connectAdapter(adapter);

    await adapter.setIntensity(999, -5);
    expect(writes.at(-1)).toEqual([0xb3, 200, 0]);
  });

  it('optimistically updates local state for numeric channels only', async () => {
    const adapter = new OpossumVibrateAdapter();
    await connectAdapter(adapter);

    await adapter.setIntensity(160, 'unchanged');
    expect(adapter.getState().intensityA).toBe(160);
    expect(adapter.getState().intensityB).toBe(0);

    await adapter.setIntensity('unchanged', 200);
    expect(adapter.getState().intensityA).toBe(160);
    expect(adapter.getState().intensityB).toBe(200);
  });

  it('builds a 20-byte 0xB0 waveform packet with channel A/B in the documented byte ranges', async () => {
    const adapter = new OpossumVibrateAdapter();
    const { writes } = await connectAdapter(adapter);

    await adapter.writeWaveformFrame([1, 2, 3, 4], [5, 6, 7, 8]);
    const packet = writes.at(-1);
    expect(packet).toHaveLength(20);
    expect(packet).toEqual([
      0xb0,
      0,
      0,
      0,
      0,
      0,
      0,
      0, // bytes 1-7 reserved
      1,
      2,
      3,
      4, // bytes 8-11: channel A
      0,
      0,
      0,
      0, // bytes 12-15 reserved
      5,
      6,
      7,
      8, // bytes 16-19: channel B
    ]);
  });

  it('clamps 0xB0 waveform bytes above 100 rather than wrapping', async () => {
    const adapter = new OpossumVibrateAdapter();
    const { writes } = await connectAdapter(adapter);

    await adapter.writeWaveformFrame([150, 0, 0, 0], [0, 0, 0, 255]);
    const packet = writes.at(-1);
    expect(packet?.[8]).toBe(100);
    expect(packet?.[19]).toBe(100);
  });

  it('builds the 0xB2 display packet with the fixed 21-byte preamble plus A/B intensity', async () => {
    // The doc's "23 bytes" total label doesn't match its own 21-byte preamble
    // enumeration (1 opcode + 21 preamble + 2 intensity = 24); this adapter
    // follows the literal byte enumeration, so the packet is 24 bytes.
    const adapter = new OpossumVibrateAdapter();
    const { writes } = await connectAdapter(adapter);

    await adapter.updateDisplay(50, 60);
    const packet = writes.at(-1);
    expect(packet).toHaveLength(24);
    expect(packet?.[0]).toBe(0xb2);
    expect(packet?.slice(1, 22)).toEqual([
      0xff, 0xff, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
      0xff, 0xff, 0xff, 0xff, 0x08, 0x09,
    ]);
    expect(packet?.[22]).toBe(50);
    expect(packet?.[23]).toBe(60);
  });

  it('builds the 3-byte 0x50 LED/button-reporting packet', async () => {
    const adapter = new OpossumVibrateAdapter();
    const { writes } = await connectAdapter(adapter);

    await adapter.setLed(7, true);
    expect(writes.at(-1)).toEqual([0x50, 7, 0x01]);

    await adapter.setLed(7, false);
    expect(writes.at(-1)).toEqual([0x50, 7, 0x00]);
  });

  it('clamps the LED color byte to the documented 0-7 enum', async () => {
    const adapter = new OpossumVibrateAdapter();
    const { writes } = await connectAdapter(adapter);

    await adapter.setLed(255, true);
    expect(writes.at(-1)).toEqual([0x50, 7, 0x01]);

    await adapter.setLed(-3, true);
    expect(writes.at(-1)).toEqual([0x50, 0, 0x01]);
  });

  it('emergencyStop drives both channels to zero and swallows write failures', async () => {
    const failingWriteChar = new MockCharacteristic(() => {
      throw new Error('gatt write failed');
    });
    const adapter = new OpossumVibrateAdapter();
    await connectAdapter(adapter, { writeChar: failingWriteChar });

    await expect(adapter.emergencyStop()).resolves.toBeUndefined();
  });
});

describe('OpossumVibrateAdapter incoming notifications', () => {
  it('parses a 0xB3 notification and updates intensityA/intensityB', async () => {
    const adapter = new OpossumVibrateAdapter();
    const { notifyChar } = await connectAdapter(adapter);

    notifyChar.emitNotification([0xb3, 42, 99]);

    expect(adapter.getState().intensityA).toBe(42);
    expect(adapter.getState().intensityB).toBe(99);
  });

  it('notifies onStateChanged subscribers when a 0xB3 notification arrives', async () => {
    const adapter = new OpossumVibrateAdapter();
    const { notifyChar } = await connectAdapter(adapter);

    const seen: number[] = [];
    const unsubscribe = adapter.onStateChanged((state) => {
      seen.push(state.intensityA);
    });

    notifyChar.emitNotification([0xb3, 15, 0]);
    unsubscribe();

    expect(seen).toContain(15);
  });

  it('parses a 0xD0 button bitmap into the correct pressed set (SEL_1 + B)', async () => {
    const adapter = new OpossumVibrateAdapter();
    const { notifyChar } = await connectAdapter(adapter);

    const events: Array<{ sequence: number; pressed: Set<string> }> = [];
    adapter.subscribeButtons((event) => events.push(event));

    // bit0 (SEL_1) set in low byte, bit12 (B) set in high byte (bit 4 of byte).
    const low = 0b00000001;
    const high = 0b00010000;
    notifyChar.emitNotification([0xd0, 7, low, high, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

    expect(events).toHaveLength(1);
    expect(events[0]?.sequence).toBe(7);
    expect(events[0]?.pressed).toEqual(new Set(['SEL_1', 'B']));
  });

  it('parses a 0xD0 button bitmap into the correct pressed set (Up + D)', async () => {
    const adapter = new OpossumVibrateAdapter();
    const { notifyChar } = await connectAdapter(adapter);

    const events: Array<{ sequence: number; pressed: Set<string> }> = [];
    adapter.subscribeButtons((event) => events.push(event));

    // bit8 (Up) is bit0 of the high byte, bit15 (D) is bit7 of the high byte.
    const low = 0b00000000;
    const high = 0b10000001;
    notifyChar.emitNotification([0xd0, 3, low, high, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

    expect(events).toHaveLength(1);
    expect(events[0]?.sequence).toBe(3);
    expect(events[0]?.pressed).toEqual(new Set(['Up', 'D']));
  });

  it('reports no pressed buttons when the bitmap is all zero', async () => {
    const adapter = new OpossumVibrateAdapter();
    const { notifyChar } = await connectAdapter(adapter);

    const events: Array<{ sequence: number; pressed: Set<string> }> = [];
    adapter.subscribeButtons((event) => events.push(event));

    notifyChar.emitNotification([0xd0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

    expect(events).toHaveLength(1);
    expect(events[0]?.pressed.size).toBe(0);
  });

  it('unsubscribing a button listener stops further delivery', async () => {
    const adapter = new OpossumVibrateAdapter();
    const { notifyChar } = await connectAdapter(adapter);

    const events: unknown[] = [];
    const unsubscribe = adapter.subscribeButtons((event) => events.push(event));
    unsubscribe();

    notifyChar.emitNotification([0xd0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(events).toHaveLength(0);
  });
});

describe('OpossumVibrateAdapter connection lifecycle', () => {
  it('onConnected resolves write/notify/battery characteristics and sets connected state', async () => {
    const adapter = new OpossumVibrateAdapter();
    await connectAdapter(adapter, { deviceName: '47L127000', deviceId: 'opossum-1' });

    const state = adapter.getState();
    expect(state).toEqual({
      connected: true,
      deviceName: '47L127000',
      address: 'opossum-1',
      battery: 77,
      intensityA: 0,
      intensityB: 0,
    });
  });

  it('best-effort defaults battery to 0 when the battery service is unavailable', async () => {
    const adapter = new OpossumVibrateAdapter();
    await connectAdapter(adapter, { batteryUnavailable: true });

    expect(adapter.getState().battery).toBe(0);
    expect(adapter.getState().connected).toBe(true);
  });

  it('onDisconnected resets state to empty and notifies state listeners', async () => {
    const adapter = new OpossumVibrateAdapter();
    await connectAdapter(adapter);

    const seen: Array<{ connected: boolean }> = [];
    adapter.onStateChanged((state) => seen.push(state));

    await adapter.onDisconnected();

    expect(adapter.getState()).toEqual(createEmptyOpossumState());
    expect(seen.at(-1)?.connected).toBe(false);
  });

  it('rolls back cleanly and rethrows when the primary service is unavailable', async () => {
    const adapter = new OpossumVibrateAdapter();

    await expect(
      adapter.onConnected({
        device: { name: '47L127000', id: 'broken' } as unknown as EventTarget & {
          id?: string;
          name?: string;
        },
        server: {
          connected: true,
          async getPrimaryService() {
            throw new Error('primary service unavailable');
          },
        },
      }),
    ).rejects.toThrow('primary service unavailable');

    expect(adapter.getState().connected).toBe(false);
  });

  it('writing commands before connecting throws', async () => {
    const adapter = new OpossumVibrateAdapter();
    await expect(adapter.setIntensity(10, 10)).rejects.toThrow();
  });

  it('tears down the notify subscription on a connect failure that happens after it was established', async () => {
    // Regression: onConnected's catch block used to only null the
    // characteristic references, leaving a live GATT notification
    // subscription (startNotifications + addEventListener already
    // succeeded) dangling with nothing left to ever call
    // stopNotifications()/removeEventListener() for it.
    const adapter = new OpossumVibrateAdapter();
    const writeChar = new MockCharacteristic();
    const notifyChar = new MockCharacteristic();
    const server = createMockServer({ writeChar, notifyChar });

    adapter.onStateChanged(() => {
      throw new Error('boom — simulates any failure after notify subscription succeeds');
    });

    await expect(
      adapter.onConnected({
        device: { name: '47L127000', id: 'opossum-device' } as unknown as EventTarget & {
          id?: string;
          name?: string;
        },
        server,
      }),
    ).rejects.toThrow('boom');

    expect(notifyChar.stopNotificationsCallCount).toBe(1);
    expect(adapter.getState().connected).toBe(false);
  });

  it('adjustIntensity reads-then-writes the new absolute value atomically', async () => {
    const { adapter, writes } = await (async () => {
      const adapter = new OpossumVibrateAdapter();
      const result = await connectAdapter(adapter);
      result.writes.length = 0;
      return { adapter, writes: result.writes };
    })();

    await adapter.setIntensity(50, 80);
    writes.length = 0;

    await adapter.adjustIntensity('A', 15);
    expect(adapter.getState().intensityA).toBe(65);
    expect(adapter.getState().intensityB).toBe(80);
    expect(writes[0]).toEqual([0xb3, 65, 0xff]);

    await adapter.adjustIntensity('B', -20);
    expect(adapter.getState().intensityB).toBe(60);

    // Clamps at the range boundary rather than under/overflowing.
    await adapter.adjustIntensity('A', 1000);
    expect(adapter.getState().intensityA).toBe(200);
  });
});
