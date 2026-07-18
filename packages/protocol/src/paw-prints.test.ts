import { describe, expect, it } from 'vitest';
import {
  V3_BATTERY_CHAR,
  V3_BATTERY_SERVICE,
  V3_NOTIFY_CHAR,
  V3_PRIMARY_SERVICE,
  V3_WRITE_CHAR,
} from './constants.js';
import { PawPrintsSensorAdapter, type PawPrintsReading } from './paw-prints.js';

/** Minimal mock modeled on `MockCharacteristic` in protocol.test.ts. */
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
    return this.value ?? new DataView(new ArrayBuffer(0));
  }

  async startNotifications(): Promise<MockCharacteristic> {
    return this;
  }

  async stopNotifications(): Promise<MockCharacteristic> {
    return this;
  }

  /** Simulate an inbound notification carrying the given raw bytes. */
  notify(bytes: number[]): void {
    this.value = new DataView(Uint8Array.from(bytes).buffer);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}

function int16LE(value: number): [number, number] {
  const buffer = new ArrayBuffer(2);
  new DataView(buffer).setInt16(0, value, true);
  return Array.from(new Uint8Array(buffer)) as [number, number];
}

interface MockServerOptions {
  writeChar: MockCharacteristic;
  notifyChar: MockCharacteristic;
  batteryChar?: MockCharacteristic;
  batteryThrows?: boolean;
  primaryServiceThrows?: boolean;
}

function buildServer(options: MockServerOptions) {
  return {
    connected: true,
    async getPrimaryService(service: string) {
      if (service === V3_PRIMARY_SERVICE) {
        if (options.primaryServiceThrows) {
          throw new Error('primary service unavailable');
        }
        return {
          async getCharacteristic(characteristic: string) {
            if (characteristic === V3_WRITE_CHAR) return options.writeChar;
            if (characteristic === V3_NOTIFY_CHAR) return options.notifyChar;
            throw new Error(`unknown characteristic: ${characteristic}`);
          },
        };
      }
      if (service === V3_BATTERY_SERVICE) {
        if (options.batteryThrows || !options.batteryChar) {
          throw new Error('battery unavailable');
        }
        const batteryChar = options.batteryChar;
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

function buildDevice(name: string, id: string) {
  return { name, id } as unknown as EventTarget & { id?: string; name?: string };
}

describe('PawPrintsSensorAdapter notification parsing', () => {
  async function connectWithNotifyChar(): Promise<{
    adapter: PawPrintsSensorAdapter;
    notifyChar: MockCharacteristic;
    readings: PawPrintsReading[];
  }> {
    const writeChar = new MockCharacteristic();
    const notifyChar = new MockCharacteristic();
    const adapter = new PawPrintsSensorAdapter();

    await adapter.onConnected({
      device: buildDevice('47L120001', 'paw-prints-1'),
      server: buildServer({ writeChar, notifyChar, batteryThrows: true }),
    });

    const readings: PawPrintsReading[] = [];
    adapter.subscribe((reading) => readings.push(reading));

    return { adapter, notifyChar, readings };
  }

  it('parses a 0x51 status notification', async () => {
    const { notifyChar, readings } = await connectWithNotifyChar();
    notifyChar.notify([0x51, 0x06, 0x03, 88]);

    expect(readings).toEqual([{ type: 'status', color: 0x06, deviceType: 0x03, battery: 88 }]);
  });

  it('parses a 0x5A trigger notification', async () => {
    const { notifyChar, readings } = await connectWithNotifyChar();
    notifyChar.notify([0x5a, 0x02, 12, 200]);

    expect(readings).toEqual([{ type: 'trigger', eventId: 12, parameterValue: 200 }]);
  });

  it('parses a 0x5B trigger-cancel notification', async () => {
    const { notifyChar, readings } = await connectWithNotifyChar();
    notifyChar.notify([0x5b, 0x02, 7]);

    expect(readings).toEqual([{ type: 'triggerCancel', eventId: 7 }]);
  });

  it('parses a 0x5C parameter-change notification', async () => {
    const { notifyChar, readings } = await connectWithNotifyChar();
    notifyChar.notify([0x5c, 0x02, 9, 150]);

    expect(readings).toEqual([{ type: 'parameterChange', eventId: 9, value: 150 }]);
  });

  it('parses a 0xD0 physical-data notification, treating angles as signed bytes', async () => {
    const { notifyChar, readings } = await connectWithNotifyChar();
    // xAngle=-1 (0xFF), yAngle=127 (0x7F), zAngle=-128 (0x80)
    notifyChar.notify([0xd0, 0x04, 5, 1, 250, 0xff, 0x7f, 0x80, 210]);

    expect(readings).toEqual([
      {
        type: 'physical',
        sequence: 5,
        pressState: 1,
        acceleration: 250,
        angleX: -1,
        angleY: 127,
        angleZ: -128,
        extVoltage: 210,
      },
    ]);
  });

  it('parses a 0xF1 auto-detect-result notification with little-endian signed ranges', async () => {
    const { notifyChar, readings } = await connectWithNotifyChar();
    const bytes = [
      0xf1,
      0x61,
      ...int16LE(-100),
      ...int16LE(300),
      ...int16LE(-1),
      ...int16LE(1),
      ...int16LE(500),
      ...int16LE(-500),
    ];
    notifyChar.notify(bytes);

    expect(readings).toEqual([
      {
        type: 'autoDetectResult',
        xRange: [-100, 300],
        yRange: [-1, 1],
        zRange: [500, -500],
      },
    ]);
  });

  it('ignores unknown opcodes and undersized payloads', async () => {
    const { notifyChar, readings } = await connectWithNotifyChar();
    notifyChar.notify([0x99, 0x01, 0x02]);
    notifyChar.notify([0x51, 0x01]); // too short for a status frame
    notifyChar.notify([0xf1, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]); // wrong marker byte

    expect(readings).toEqual([]);
  });
});

describe('PawPrintsSensorAdapter command writes', () => {
  async function connectWithWriteChar(): Promise<{
    adapter: PawPrintsSensorAdapter;
    writes: number[][];
  }> {
    const writes: number[][] = [];
    const writeChar = new MockCharacteristic(async (value) => {
      writes.push(Array.from(value));
    });
    const notifyChar = new MockCharacteristic();
    const adapter = new PawPrintsSensorAdapter();

    await adapter.onConnected({
      device: buildDevice('47L120002', 'paw-prints-2'),
      server: buildServer({ writeChar, notifyChar, batteryThrows: true }),
    });

    return { adapter, writes };
  }

  it('writes a 17-byte 0x50 packet for configureTrigger, zero-padding a short config', async () => {
    const { adapter, writes } = await connectWithWriteChar();

    await adapter.configureTrigger(0x0f, 0x02, Uint8Array.of(1, 2, 3));

    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual([
      0x50, 0x02, 0x0f, 1, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(writes[0]).toHaveLength(17);
  });

  it('writes a 17-byte 0x50 packet with an all-zero config block when omitted', async () => {
    const { adapter, writes } = await connectWithWriteChar();

    await adapter.configureTrigger(0x03, 0x05);

    expect(writes[0]).toEqual([0x50, 0x05, 0x03, ...new Array(14).fill(0)]);
  });

  it('writes the 1-byte 0x5F reset-parameters packet', async () => {
    const { adapter, writes } = await connectWithWriteChar();

    await adapter.resetParameters();

    expect(writes).toEqual([[0x5f]]);
  });

  it('writes the 1-byte 0x60 start-angle-detection packet', async () => {
    const { adapter, writes } = await connectWithWriteChar();

    await adapter.startAngleDetection();

    expect(writes).toEqual([[0x60]]);
  });

  it('writes a solid-color 0x70 LED packet', async () => {
    const { adapter, writes } = await connectWithWriteChar();

    await adapter.setLedSolid(0x04);

    expect(writes).toEqual([[0x70, 0x04]]);
  });

  it('writes a blink 0x70 LED packet with two colors and a speed byte', async () => {
    const { adapter, writes } = await connectWithWriteChar();

    await adapter.setLedBlink(0x02, 0x06, 0x01);

    expect(writes).toEqual([[0x70, 0x02, 0x06, 0x01]]);
  });

  it('rejects command writes when not connected', async () => {
    const adapter = new PawPrintsSensorAdapter();
    await expect(adapter.resetParameters()).rejects.toThrow('not connected');
  });
});

describe('PawPrintsSensorAdapter connect/disconnect round trip', () => {
  it('connects, resolves battery best-effort, and reports state', async () => {
    const writeChar = new MockCharacteristic();
    const notifyChar = new MockCharacteristic();
    const batteryChar = new MockCharacteristic();
    batteryChar.value = new DataView(Uint8Array.of(77).buffer);

    const adapter = new PawPrintsSensorAdapter();
    const states: ReturnType<PawPrintsSensorAdapter['getState']>[] = [];
    adapter.onStateChanged((state) => states.push(state));

    await adapter.onConnected({
      device: buildDevice('47L120003', 'paw-prints-3'),
      server: buildServer({ writeChar, notifyChar, batteryChar }),
    });

    expect(adapter.getState()).toEqual({
      connected: true,
      deviceName: '47L120003',
      address: 'paw-prints-3',
      battery: 77,
    });
    expect(states.at(-1)).toEqual(adapter.getState());
  });

  it('defaults battery to 0 when the battery service read fails', async () => {
    const writeChar = new MockCharacteristic();
    const notifyChar = new MockCharacteristic();
    const adapter = new PawPrintsSensorAdapter();

    await adapter.onConnected({
      device: buildDevice('47L120004', 'paw-prints-4'),
      server: buildServer({ writeChar, notifyChar, batteryThrows: true }),
    });

    expect(adapter.getState().connected).toBe(true);
    expect(adapter.getState().battery).toBe(0);
  });

  it('resets to a disconnected sensor state and stops delivering readings after onDisconnected', async () => {
    const writeChar = new MockCharacteristic();
    const notifyChar = new MockCharacteristic();
    const adapter = new PawPrintsSensorAdapter();

    await adapter.onConnected({
      device: buildDevice('47L120005', 'paw-prints-5'),
      server: buildServer({ writeChar, notifyChar, batteryThrows: true }),
    });

    const readings: PawPrintsReading[] = [];
    adapter.subscribe((reading) => readings.push(reading));

    await adapter.onDisconnected();

    expect(adapter.getState()).toEqual({
      connected: false,
      deviceName: '47L120005',
      address: 'paw-prints-5',
      battery: 0,
    });

    // Notification listener must have been detached — firing again should
    // not deliver a reading.
    notifyChar.notify([0x51, 0x01, 0x03, 50]);
    expect(readings).toEqual([]);
  });

  it('rolls back to a disconnected state, preserving the attempted device name, when connect fails', async () => {
    const writeChar = new MockCharacteristic();
    const notifyChar = new MockCharacteristic();
    const adapter = new PawPrintsSensorAdapter();

    await expect(
      adapter.onConnected({
        device: buildDevice('47L120006', 'broken-paw-prints'),
        server: buildServer({ writeChar, notifyChar, primaryServiceThrows: true }),
      }),
    ).rejects.toThrow('primary service unavailable');

    expect(adapter.getState().connected).toBe(false);
    expect(adapter.getState().deviceName).toBe('47L120006');
  });
});
