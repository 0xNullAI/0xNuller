import { describe, expect, it } from 'vitest';
import { CivetPressureSensorAdapter, type CivetPressureReading } from './civet-edging.js';
import {
  V3_BATTERY_CHAR,
  V3_BATTERY_SERVICE,
  V3_NOTIFY_CHAR,
  V3_PRIMARY_SERVICE,
  V3_WRITE_CHAR,
} from './constants.js';
import type {
  BluetoothDeviceLike,
  BluetoothRemoteGATTServerLike,
  BluetoothRemoteGATTServiceLike,
} from './types.js';

// Minimal mock modeled on MockCharacteristic in protocol.test.ts, duplicated
// here rather than imported so this test file stays self-contained.
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
    return new DataView(new ArrayBuffer(1));
  }

  async startNotifications(): Promise<MockCharacteristic> {
    return this;
  }

  async stopNotifications(): Promise<MockCharacteristic> {
    return this;
  }

  emitNotification(bytes: number[]): void {
    this.value = new DataView(Uint8Array.from(bytes).buffer);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}

class MockBatteryCharacteristic extends MockCharacteristic {
  constructor(private readonly level: number) {
    super();
  }

  override async readValue(): Promise<DataView> {
    return new DataView(Uint8Array.from([this.level]).buffer);
  }
}

interface MockServerOptions {
  writeChar: MockCharacteristic;
  notifyChar: MockCharacteristic;
  batteryLevel?: number;
  failBattery?: boolean;
}

function createMockServer(options: MockServerOptions): BluetoothRemoteGATTServerLike {
  const primaryService: BluetoothRemoteGATTServiceLike = {
    getCharacteristic: async (uuid: string) => {
      if (uuid === V3_WRITE_CHAR) return options.writeChar;
      if (uuid === V3_NOTIFY_CHAR) return options.notifyChar;
      throw new Error(`unexpected characteristic ${uuid}`);
    },
  };

  const batteryService: BluetoothRemoteGATTServiceLike = {
    getCharacteristic: async (uuid: string) => {
      if (uuid === V3_BATTERY_CHAR) {
        if (options.failBattery) throw new Error('battery unavailable');
        return new MockBatteryCharacteristic(options.batteryLevel ?? 0);
      }
      throw new Error(`unexpected characteristic ${uuid}`);
    },
  };

  return {
    connected: true,
    getPrimaryService: async (uuid: string) => {
      if (uuid === V3_PRIMARY_SERVICE) return primaryService;
      if (uuid === V3_BATTERY_SERVICE) {
        if (options.failBattery) throw new Error('battery service unavailable');
        return batteryService;
      }
      throw new Error(`unexpected service ${uuid}`);
    },
  };
}

function createMockDevice(name = '47L124000', id = 'civet-1'): BluetoothDeviceLike {
  return Object.assign(new EventTarget(), { name, id }) as BluetoothDeviceLike;
}

describe('CivetPressureSensorAdapter pressure decoding', () => {
  it('decodes a little-endian int16 at byte offset 8-9, divided by 100', async () => {
    const writes: number[][] = [];
    const writeChar = new MockCharacteristic((value) => {
      writes.push(Array.from(value));
    });
    const notifyChar = new MockCharacteristic();
    const adapter = new CivetPressureSensorAdapter();

    const readings: CivetPressureReading[] = [];
    adapter.subscribe((reading) => readings.push(reading));

    await adapter.onConnected({
      device: createMockDevice(),
      server: createMockServer({ writeChar, notifyChar }),
    });

    // 0x16 0x03 at offset 8-9 -> raw 0x0316 = 790 -> 7.90 kPa
    notifyChar.emitNotification([0xd0, 0x00, 0, 0, 0, 0, 0, 0, 0x16, 0x03, 0, 0, 0, 0, 0, 0]);
    // 0xA8 0x06 at offset 8-9 -> raw 0x06A8 = 1704 -> 17.04 kPa
    notifyChar.emitNotification([0xd0, 0x00, 0, 0, 0, 0, 0, 0, 0xa8, 0x06, 0, 0, 0, 0, 0, 0]);

    expect(readings).toHaveLength(2);
    expect(readings[0]).toEqual({ type: 'pressure', kPa: 7.9 });
    expect(readings[1]).toEqual({ type: 'pressure', kPa: 17.04 });
  });

  it('ignores notifications that are not the 0xD0 pressure opcode', async () => {
    const writeChar = new MockCharacteristic();
    const notifyChar = new MockCharacteristic();
    const adapter = new CivetPressureSensorAdapter();

    const readings: CivetPressureReading[] = [];
    adapter.subscribe((reading) => readings.push(reading));

    await adapter.onConnected({
      device: createMockDevice(),
      server: createMockServer({ writeChar, notifyChar }),
    });

    notifyChar.emitNotification([0x66, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

    expect(readings).toHaveLength(0);
  });
});

describe('CivetPressureSensorAdapter command bytes', () => {
  it('startPressureReporting writes the 0x50 packet with startStopByte 0xD0', async () => {
    const writes: number[][] = [];
    const writeChar = new MockCharacteristic((value) => {
      writes.push(Array.from(value));
    });
    const notifyChar = new MockCharacteristic();
    const adapter = new CivetPressureSensorAdapter();

    await adapter.onConnected({
      device: createMockDevice(),
      server: createMockServer({ writeChar, notifyChar }),
    });

    // onConnected already auto-starts; capture that packet plus an explicit call.
    writes.length = 0;
    await adapter.startPressureReporting(0x07);

    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual([0x50, 0x07, 0xd0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(writes[0]).toHaveLength(17);
  });

  it('stopPressureReporting writes the 0x50 packet with startStopByte 0x00', async () => {
    const writes: number[][] = [];
    const writeChar = new MockCharacteristic((value) => {
      writes.push(Array.from(value));
    });
    const notifyChar = new MockCharacteristic();
    const adapter = new CivetPressureSensorAdapter();

    await adapter.onConnected({
      device: createMockDevice(),
      server: createMockServer({ writeChar, notifyChar }),
    });

    writes.length = 0;
    await adapter.stopPressureReporting();

    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual([0x50, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('calibrateZero writes the exact reset packet', async () => {
    const writes: number[][] = [];
    const writeChar = new MockCharacteristic((value) => {
      writes.push(Array.from(value));
    });
    const notifyChar = new MockCharacteristic();
    const adapter = new CivetPressureSensorAdapter();

    await adapter.onConnected({
      device: createMockDevice(),
      server: createMockServer({ writeChar, notifyChar }),
    });

    writes.length = 0;
    await adapter.calibrateZero();

    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual([0x66, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x02]);
  });

  it('toggleRotation places the rotation byte at index 10', async () => {
    const writes: number[][] = [];
    const writeChar = new MockCharacteristic((value) => {
      writes.push(Array.from(value));
    });
    const notifyChar = new MockCharacteristic();
    const adapter = new CivetPressureSensorAdapter();

    await adapter.onConnected({
      device: createMockDevice(),
      server: createMockServer({ writeChar, notifyChar }),
    });

    writes.length = 0;
    await adapter.toggleRotation(0x01);
    await adapter.toggleRotation(0x03);

    expect(writes).toHaveLength(2);
    expect(writes[0]).toEqual([0x66, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x01, 0, 0]);
    expect(writes[1]).toEqual([0x66, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x03, 0, 0]);
    expect(writes[0]?.[10]).toBe(0x01);
    expect(writes[1]?.[10]).toBe(0x03);
  });

  it('throws a Chinese "not connected" error when writing without a connection', async () => {
    const adapter = new CivetPressureSensorAdapter();
    await expect(adapter.calibrateZero()).rejects.toThrow('设备未连接');
  });

  it('setIndicatorColor preserves the current streaming state instead of forcing it on or off', async () => {
    const writes: number[][] = [];
    const writeChar = new MockCharacteristic((value) => {
      writes.push(Array.from(value));
    });
    const notifyChar = new MockCharacteristic();
    const adapter = new CivetPressureSensorAdapter();

    await adapter.onConnected({
      device: createMockDevice(),
      server: createMockServer({ writeChar, notifyChar }),
    });
    // onConnected() auto-starts streaming — setIndicatorColor while still
    // streaming must not stop it, unlike calling stopPressureReporting(color)
    // would.
    writes.length = 0;
    await adapter.setIndicatorColor(0x03);
    expect(writes[0]).toEqual([0x50, 0x03, 0xd0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

    await adapter.stopPressureReporting();
    writes.length = 0;
    await adapter.setIndicatorColor(0x05);
    expect(writes[0]).toEqual([0x50, 0x05, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('CivetPressureSensorAdapter connect/disconnect round trip', () => {
  it('onConnected resolves battery, sets connected state, and auto-starts streaming', async () => {
    const writes: number[][] = [];
    const writeChar = new MockCharacteristic((value) => {
      writes.push(Array.from(value));
    });
    const notifyChar = new MockCharacteristic();
    const adapter = new CivetPressureSensorAdapter();

    const states: Array<ReturnType<typeof adapter.getState>> = [];
    adapter.onStateChanged((state) => states.push(state));

    await adapter.onConnected({
      device: createMockDevice('47L124000', 'civet-addr'),
      server: createMockServer({ writeChar, notifyChar, batteryLevel: 88 }),
    });

    const state = adapter.getState();
    expect(state.connected).toBe(true);
    expect(state.deviceName).toBe('47L124000');
    expect(state.address).toBe('civet-addr');
    expect(state.battery).toBe(88);

    // onConnected() now also sends the shared connect-time handshake's init
    // packet before civet-edging's own auto-start write.
    expect(writes).toHaveLength(2);
    expect(writes[0]?.slice(0, 2)).toEqual([0x50, 0x02]);
    expect(writes[1]?.slice(0, 3)).toEqual([0x50, 0x00, 0xd0]);

    expect(states.length).toBeGreaterThan(0);
    expect(states[states.length - 1]?.connected).toBe(true);
  });

  it('best-effort defaults battery to 0 when the battery service is unavailable', async () => {
    const writeChar = new MockCharacteristic();
    const notifyChar = new MockCharacteristic();
    const adapter = new CivetPressureSensorAdapter();

    await adapter.onConnected({
      device: createMockDevice(),
      server: createMockServer({ writeChar, notifyChar, failBattery: true }),
    });

    expect(adapter.getState().connected).toBe(true);
    expect(adapter.getState().battery).toBe(0);
  });

  it('onDisconnected resets to empty sensor state and stops notifications', async () => {
    const writeChar = new MockCharacteristic();
    const notifyChar = new MockCharacteristic();
    const adapter = new CivetPressureSensorAdapter();

    const states: Array<ReturnType<typeof adapter.getState>> = [];
    adapter.onStateChanged((state) => states.push(state));

    await adapter.onConnected({
      device: createMockDevice(),
      server: createMockServer({ writeChar, notifyChar, batteryLevel: 50 }),
    });

    await adapter.onDisconnected();

    const state = adapter.getState();
    expect(state.connected).toBe(false);
    expect(state.battery).toBe(0);
    expect(state.deviceName).toBeUndefined();
    expect(states[states.length - 1]?.connected).toBe(false);

    // Notifications after disconnect must not reach subscribers.
    const readings: CivetPressureReading[] = [];
    adapter.subscribe((reading) => readings.push(reading));
    notifyChar.emitNotification([0xd0, 0, 0, 0, 0, 0, 0, 0, 0x16, 0x03, 0, 0, 0, 0, 0, 0]);
    expect(readings).toHaveLength(0);
  });

  it('unsubscribing a reading listener stops further delivery', async () => {
    const writeChar = new MockCharacteristic();
    const notifyChar = new MockCharacteristic();
    const adapter = new CivetPressureSensorAdapter();

    const readings: CivetPressureReading[] = [];
    const unsubscribe = adapter.subscribe((reading) => readings.push(reading));

    await adapter.onConnected({
      device: createMockDevice(),
      server: createMockServer({ writeChar, notifyChar }),
    });

    notifyChar.emitNotification([0xd0, 0, 0, 0, 0, 0, 0, 0, 0x16, 0x03, 0, 0, 0, 0, 0, 0]);
    expect(readings).toHaveLength(1);

    unsubscribe();
    notifyChar.emitNotification([0xd0, 0, 0, 0, 0, 0, 0, 0, 0x16, 0x03, 0, 0, 0, 0, 0, 0]);
    expect(readings).toHaveLength(1);
  });
});
