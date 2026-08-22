import { createEmptyDeviceState } from '@dg-kit/core';
import { describe, expect, it } from 'vitest';
import {
  detectDeviceKind,
  V3_HANDSHAKE_MTU,
  V3_INIT_PACKET,
  V3_NOTIFY_CHAR,
  V3_PRIMARY_SERVICE,
  V3_WRITE_CHAR,
  V2_PRIMARY_SERVICE,
  V2_STRENGTH_CHAR,
  V2_WAVE_A_CHAR,
  V2_WAVE_B_CHAR,
} from './constants.js';
import { CoyoteProtocolAdapter } from './facade.js';
import { CoyoteV2ProtocolAdapter } from './v2.js';
import { CoyoteV3ProtocolAdapter } from './v3.js';

describe('detectDeviceKind', () => {
  it('classifies every known 47L12x-family prefix and the legacy V2 name', () => {
    expect(detectDeviceKind('47L121000')).toBe('coyote');
    expect(detectDeviceKind('D-LAB ESTIM01')).toBe('coyote');
    expect(detectDeviceKind('47L120300')).toBe('paw-prints');
    expect(detectDeviceKind('47L124000')).toBe('civet-edging');
    expect(detectDeviceKind('47L127000')).toBe('opossum');
  });

  it('returns unknown for unrecognized or empty names', () => {
    expect(detectDeviceKind('some other device')).toBe('unknown');
    expect(detectDeviceKind(undefined)).toBe('unknown');
    expect(detectDeviceKind(null)).toBe('unknown');
    expect(detectDeviceKind('')).toBe('unknown');
  });
});

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

class MockCharacteristic extends EventTarget {
  value: DataView | null = null;

  constructor(private readonly onWrite: (value: Uint8Array) => Promise<void>) {
    super();
  }

  async writeValueWithoutResponse(value: ArrayBufferView | ArrayBuffer): Promise<void> {
    const buffer =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    await this.onWrite(new Uint8Array(buffer));
  }

  async readValue(): Promise<DataView> {
    return new DataView(new ArrayBuffer(0));
  }

  async startNotifications(): Promise<MockCharacteristic> {
    return this;
  }

  async stopNotifications(): Promise<MockCharacteristic> {
    return this;
  }
}

class MockResponseOnlyCharacteristic extends EventTarget {
  value: DataView | null = null;

  constructor(private readonly onWrite: (value: Uint8Array) => Promise<void>) {
    super();
  }

  async writeValueWithResponse(value: ArrayBufferView | ArrayBuffer): Promise<void> {
    const buffer =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    await this.onWrite(new Uint8Array(buffer));
  }

  async readValue(): Promise<DataView> {
    return new DataView(new ArrayBuffer(0));
  }

  async startNotifications(): Promise<MockResponseOnlyCharacteristic> {
    return this;
  }

  async stopNotifications(): Promise<MockResponseOnlyCharacteristic> {
    return this;
  }
}

describe('CoyoteV3ProtocolAdapter', () => {
  it('waits for an in-flight tick before writing the emergency stop packet', async () => {
    const firstTickWrite = createDeferred<void>();
    const writes: number[][] = [];

    const characteristic = new MockCharacteristic(async (value) => {
      writes.push(Array.from(value));
      if (writes.length === 1) {
        await firstTickWrite.promise;
      }
    });

    const protocol = new CoyoteV3ProtocolAdapter();
    const protocolInternal = protocol as unknown as {
      state: ReturnType<typeof createEmptyDeviceState>;
      writeChar: MockCharacteristic | null;
      pendingStrA: number;
      pendingStrB: number;
      onTick(): Promise<void>;
    };

    protocolInternal.state = {
      ...createEmptyDeviceState(),
      connected: true,
    };
    protocolInternal.writeChar = characteristic;
    protocolInternal.pendingStrA = 42;
    protocolInternal.pendingStrB = 0;

    const tickPromise = protocolInternal.onTick();
    expect(writes).toHaveLength(1);

    const stopPromise = protocol.emergencyStop();
    await Promise.resolve();
    expect(writes).toHaveLength(1);

    firstTickWrite.resolve();
    await tickPromise;
    await stopPromise;

    expect(writes).toHaveLength(2);
    expect(writes[0]?.slice(0, 4)).toEqual([0xb0, 0x00, 42, 0]);
    expect(writes[1]?.slice(0, 4)).toEqual([0xb0, 0x0f, 0, 0]);
    expect(protocol.getState().strengthA).toBe(0);
    expect(protocol.getState().strengthB).toBe(0);
  });

  it('ignores stale non-zero strength notifications after emergency stop', async () => {
    const characteristic = new MockCharacteristic(async () => undefined);
    const protocol = new CoyoteV3ProtocolAdapter();
    const protocolInternal = protocol as unknown as {
      state: ReturnType<typeof createEmptyDeviceState>;
      writeChar: MockCharacteristic | null;
      handleV3Notification(event: Event): void;
    };

    protocolInternal.state = {
      ...createEmptyDeviceState(),
      connected: true,
      strengthA: 10,
    };
    protocolInternal.writeChar = characteristic;

    await protocol.emergencyStop();
    expect(protocol.getState().strengthA).toBe(0);

    protocolInternal.handleV3Notification({
      target: {
        value: new DataView(Uint8Array.from([0xb1, 0x01, 10, 0]).buffer),
      },
    } as unknown as Event);

    expect(protocol.getState().strengthA).toBe(0);
    expect(protocol.getState().strengthB).toBe(0);
  });

  it('packs four sequential V3 wave frames into each B0 packet and pads the tail with silence', async () => {
    const writes: number[][] = [];
    const characteristic = new MockCharacteristic(async (value) => {
      writes.push(Array.from(value));
    });

    const protocol = new CoyoteV3ProtocolAdapter();
    const protocolInternal = protocol as unknown as {
      state: ReturnType<typeof createEmptyDeviceState>;
      writeChar: MockCharacteristic | null;
      waveState: {
        A: { frames: [number, number][] | null; index: number; loop: boolean; active: boolean };
        B: { frames: [number, number][] | null; index: number; loop: boolean; active: boolean };
      };
      onTick(): Promise<void>;
    };

    protocolInternal.state = {
      ...createEmptyDeviceState(),
      connected: true,
    };
    protocolInternal.writeChar = characteristic;
    protocolInternal.waveState.A = {
      frames: [
        [11, 10],
        [22, 20],
        [33, 30],
        [44, 40],
        [55, 50],
      ],
      index: 0,
      loop: false,
      active: true,
    };
    protocolInternal.waveState.B = {
      frames: null,
      index: 0,
      loop: false,
      active: false,
    };

    await protocolInternal.onTick();
    await protocolInternal.onTick();

    expect(writes).toHaveLength(2);
    expect(writes[0]?.slice(4, 8)).toEqual([11, 22, 33, 44]);
    expect(writes[0]?.slice(8, 12)).toEqual([10, 20, 30, 40]);
    expect(writes[1]?.slice(4, 8)).toEqual([55, 10, 10, 10]);
    expect(writes[1]?.slice(8, 12)).toEqual([50, 0, 0, 0]);
    expect(writes[1]?.slice(12, 20)).toEqual([0, 0, 0, 0, 0, 0, 0, 101]);
    expect(protocol.getState().waveActiveA).toBe(false);
  });
});

describe('setLimits', () => {
  it('writes a BF packet on V3 with the new limit values', async () => {
    const writes: number[][] = [];
    const characteristic = new MockCharacteristic(async (value) => {
      writes.push(Array.from(value));
    });

    const protocol = new CoyoteV3ProtocolAdapter();
    const protocolInternal = protocol as unknown as {
      state: ReturnType<typeof createEmptyDeviceState>;
      writeChar: MockCharacteristic | null;
    };

    protocolInternal.state = {
      ...createEmptyDeviceState(),
      connected: true,
      limitA: 200,
      limitB: 200,
    };
    protocolInternal.writeChar = characteristic;

    await protocol.setLimits(80, 60);

    expect(protocol.getState().limitA).toBe(80);
    expect(protocol.getState().limitB).toBe(60);
    // Last write must be the BF packet (0xBF, limitA, limitB, …)
    const lastWrite = writes.at(-1);
    expect(lastWrite?.[0]).toBe(0xbf);
    expect(lastWrite?.[1]).toBe(80);
    expect(lastWrite?.[2]).toBe(60);
  });

  it('clamps current strength downward when the limit is reduced', async () => {
    const protocol = new CoyoteV3ProtocolAdapter();
    const protocolInternal = protocol as unknown as {
      state: ReturnType<typeof createEmptyDeviceState>;
      writeChar: { writeValueWithoutResponse(): Promise<void> } | null;
    };

    protocolInternal.state = {
      ...createEmptyDeviceState(),
      connected: true,
      strengthA: 90,
      strengthB: 30,
      limitA: 200,
      limitB: 200,
    };
    protocolInternal.writeChar = {
      writeValueWithoutResponse: async () => undefined,
    };

    await protocol.setLimits(50, 50);

    expect(protocol.getState().strengthA).toBe(50);
    expect(protocol.getState().strengthB).toBe(30);
  });
});

describe('CoyoteV2ProtocolAdapter', () => {
  it('connects and initializes when V2 characteristics only support write with response', async () => {
    const strengthWrites: number[][] = [];
    const waveWrites: number[][] = [];
    const strengthChar = new MockResponseOnlyCharacteristic(async (value) => {
      strengthWrites.push(Array.from(value));
    });
    const waveAChar = new MockResponseOnlyCharacteristic(async (value) => {
      waveWrites.push(Array.from(value));
    });
    const waveBChar = new MockResponseOnlyCharacteristic(async (value) => {
      waveWrites.push(Array.from(value));
    });

    const protocol = new CoyoteV2ProtocolAdapter();
    const protocolInternal = protocol as unknown as {
      pendingStrA: number;
      onTick(): Promise<void>;
    };

    await protocol.onConnected({
      device: { name: 'D-LAB ESTIM01', id: 'v2-device' } as unknown as EventTarget & {
        id?: string;
        name?: string;
      },
      server: {
        connected: true,
        async getPrimaryService(service: string) {
          if (service !== V2_PRIMARY_SERVICE) {
            throw new Error('battery unavailable');
          }
          return {
            async getCharacteristic(characteristic: string) {
              if (characteristic === V2_STRENGTH_CHAR) return strengthChar;
              if (characteristic === V2_WAVE_A_CHAR) return waveAChar;
              if (characteristic === V2_WAVE_B_CHAR) return waveBChar;
              throw new Error(`unknown characteristic: ${characteristic}`);
            },
          };
        },
      },
    });

    expect(protocol.getState().connected).toBe(true);
    expect(protocol.getState().battery).toBeUndefined();
    expect(strengthWrites[0]).toEqual([0, 0, 0]);

    protocolInternal.pendingStrA = 10;
    await protocolInternal.onTick();

    expect(strengthWrites).toHaveLength(2);
    expect(strengthWrites[1]).not.toBeUndefined();

    await protocol.onDisconnected();
  });

  it('writes V2 strength and wave packets little-endian (A wave on 1506, B wave on 1505)', async () => {
    const strengthWrites: number[][] = [];
    const waveAWrites: number[][] = [];
    const waveBWrites: number[][] = [];
    const strengthChar = new MockResponseOnlyCharacteristic(async (value) => {
      strengthWrites.push(Array.from(value));
    });
    const waveAChar = new MockResponseOnlyCharacteristic(async (value) => {
      waveAWrites.push(Array.from(value));
    });
    const waveBChar = new MockResponseOnlyCharacteristic(async (value) => {
      waveBWrites.push(Array.from(value));
    });

    const protocol = new CoyoteV2ProtocolAdapter();
    const protocolInternal = protocol as unknown as {
      pendingStrA: number;
      pendingStrB: number;
      waveState: {
        A: { frames: [number, number][] | null; index: number; loop: boolean; active: boolean };
        B: { frames: [number, number][] | null; index: number; loop: boolean; active: boolean };
      };
      onTick(): Promise<void>;
    };

    await protocol.onConnected({
      device: { name: 'D-LAB ESTIM01', id: 'v2-device' } as unknown as EventTarget & {
        id?: string;
        name?: string;
      },
      server: {
        connected: true,
        async getPrimaryService(service: string) {
          if (service !== V2_PRIMARY_SERVICE) {
            throw new Error('battery unavailable');
          }
          return {
            async getCharacteristic(characteristic: string) {
              if (characteristic === V2_STRENGTH_CHAR) return strengthChar;
              if (characteristic === V2_WAVE_A_CHAR) return waveAChar;
              if (characteristic === V2_WAVE_B_CHAR) return waveBChar;
              throw new Error(`unknown characteristic: ${characteristic}`);
            },
          };
        },
      },
    });

    protocolInternal.pendingStrA = 10;
    protocolInternal.waveState.A = {
      frames: [[100, 10]],
      index: 0,
      loop: true,
      active: true,
    };
    await protocolInternal.onTick();

    // A=10, B=0 → (102 << 11) | 0 = 0x33000, little-endian bytes.
    expect(strengthWrites.at(-1)).toEqual([0x00, 0x30, 0x03]);
    // A frame [100,10] → X=5/Y=95/Z=3 → 0x18BE5, written to 1506 (waveBChar).
    expect(waveBWrites.at(-1)).toEqual([0xe5, 0x8b, 0x01]);
    // An inactive B channel writes silence to 1505 (waveAChar).
    expect(waveAWrites.at(-1)).toEqual([0x00, 0x00, 0x00]);

    protocolInternal.pendingStrB = 10;
    protocolInternal.waveState.B = {
      frames: [[200, 20]],
      index: 0,
      loop: true,
      active: true,
    };
    await protocolInternal.onTick();

    // A=10, B=10 → 0x33066, little-endian bytes.
    expect(strengthWrites.at(-1)).toEqual([0x66, 0x30, 0x03]);
    // B frame [200,20] → X=12/Y=588/Z=6 → 0x3498C, written to 1505 (waveAChar).
    expect(waveAWrites.at(-1)).toEqual([0x8c, 0x49, 0x03]);

    protocolInternal.pendingStrA = 0;
    protocolInternal.pendingStrB = 20;
    await protocolInternal.onTick();
    // A=0, B=20 → 0x000CD, little-endian bytes.
    expect(strengthWrites.at(-1)).toEqual([0xcd, 0x00, 0x00]);

    await protocol.onDisconnected();
  });

  it('parses V2 strength notifications as little-endian', async () => {
    const protocol = new CoyoteV2ProtocolAdapter();
    const protocolInternal = protocol as unknown as {
      state: ReturnType<typeof createEmptyDeviceState>;
      handleV2StrengthNotification(event: Event): void;
    };

    protocolInternal.state = {
      ...createEmptyDeviceState(),
      connected: true,
    };

    // [0xCD, 0x30, 0x03] little-endian → A=102, B=205; scale back to 10 and 20.
    protocolInternal.handleV2StrengthNotification({
      target: { value: new DataView(Uint8Array.from([0xcd, 0x30, 0x03]).buffer) },
    } as unknown as Event);

    expect(protocol.getState().strengthA).toBe(10);
    expect(protocol.getState().strengthB).toBe(20);
  });

  it('rolls back to a disconnected state when early V2 initialization fails', async () => {
    const protocol = new CoyoteV2ProtocolAdapter();

    await expect(
      protocol.onConnected({
        device: { name: 'D-LAB ESTIM01', id: 'broken-v2' } as unknown as EventTarget & {
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

    expect(protocol.getState().connected).toBe(false);
    expect(protocol.getState().deviceName).toBe('D-LAB ESTIM01');
  });
});

describe('CoyoteV3ProtocolAdapter rollback', () => {
  it('rolls back to a disconnected state when early V3 initialization fails', async () => {
    const protocol = new CoyoteV3ProtocolAdapter();

    await expect(
      protocol.onConnected({
        device: { name: '47L121000', id: 'broken-v3' } as unknown as EventTarget & {
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

    expect(protocol.getState().connected).toBe(false);
    expect(protocol.getState().deviceName).toBe('47L121000');
  });
});

describe('CoyoteV3ProtocolAdapter connect handshake', () => {
  it('writes the init packet before BF, and tolerates missing legacy/OTA services', async () => {
    const writes: number[][] = [];
    const writeChar = new MockCharacteristic(async (value) => {
      writes.push(Array.from(value));
    });
    const notifyChar = new MockCharacteristic(async () => undefined);

    const protocol = new CoyoteV3ProtocolAdapter();

    await protocol.onConnected({
      device: { name: '47L121000', id: 'handshake-device' } as unknown as EventTarget & {
        id?: string;
        name?: string;
      },
      server: {
        connected: true,
        async getPrimaryService(service: string) {
          if (service !== V3_PRIMARY_SERVICE) {
            // Legacy/OTA/battery services are absent on this mock device —
            // the handshake must not treat that as fatal.
            throw new Error(`service unavailable: ${service}`);
          }
          return {
            async getCharacteristic(characteristic: string) {
              if (characteristic === V3_WRITE_CHAR) return writeChar;
              if (characteristic === V3_NOTIFY_CHAR) return notifyChar;
              throw new Error(`unknown characteristic: ${characteristic}`);
            },
          };
        },
      },
    });

    expect(protocol.getState().connected).toBe(true);
    expect(protocol.getState().battery).toBeUndefined();
    expect(writes[0]).toEqual(Array.from(V3_INIT_PACKET));
    expect(writes[1]?.[0]).toBe(0xbf);

    await protocol.onDisconnected();
  });

  it('still connects and writes BF/B0 normally if the init packet write itself is rejected', async () => {
    // Guards backward compatibility with firmware that, for whatever reason,
    // doesn't accept the init write — the connection must not be treated as
    // failed just because this best-effort step didn't go through.
    const writes: number[][] = [];
    let writeCount = 0;
    const writeChar = new MockCharacteristic(async (value) => {
      writeCount += 1;
      if (writeCount === 1) {
        throw new Error('unsupported by this firmware');
      }
      writes.push(Array.from(value));
    });
    const notifyChar = new MockCharacteristic(async () => undefined);

    const protocol = new CoyoteV3ProtocolAdapter();

    await protocol.onConnected({
      device: { name: '47L121000', id: 'old-firmware-device' } as unknown as EventTarget & {
        id?: string;
        name?: string;
      },
      server: {
        connected: true,
        async getPrimaryService(service: string) {
          if (service !== V3_PRIMARY_SERVICE) {
            throw new Error(`service unavailable: ${service}`);
          }
          return {
            async getCharacteristic(characteristic: string) {
              if (characteristic === V3_WRITE_CHAR) return writeChar;
              if (characteristic === V3_NOTIFY_CHAR) return notifyChar;
              throw new Error(`unknown characteristic: ${characteristic}`);
            },
          };
        },
      },
    });

    expect(protocol.getState().connected).toBe(true);
    // The rejected init write doesn't produce a recorded write, but the
    // subsequent BF write still goes through.
    expect(writes[0]?.[0]).toBe(0xbf);

    await protocol.onDisconnected();
  });

  it('requests the handshake MTU when the transport supports it', async () => {
    const writeChar = new MockCharacteristic(async () => undefined);
    const notifyChar = new MockCharacteristic(async () => undefined);
    const requestedMtu: number[] = [];

    const protocol = new CoyoteV3ProtocolAdapter();

    await protocol.onConnected({
      device: { name: '47L121000', id: 'mtu-device' } as unknown as EventTarget & {
        id?: string;
        name?: string;
      },
      server: {
        connected: true,
        async getPrimaryService(service: string) {
          if (service !== V3_PRIMARY_SERVICE) {
            throw new Error(`service unavailable: ${service}`);
          }
          return {
            async getCharacteristic(characteristic: string) {
              if (characteristic === V3_WRITE_CHAR) return writeChar;
              if (characteristic === V3_NOTIFY_CHAR) return notifyChar;
              throw new Error(`unknown characteristic: ${characteristic}`);
            },
          };
        },
        async requestMTU(mtu: number) {
          requestedMtu.push(mtu);
          return mtu;
        },
      },
    });

    expect(requestedMtu).toEqual([V3_HANDSHAKE_MTU]);

    await protocol.onDisconnected();
  });
});

describe('CoyoteProtocolAdapter facade', () => {
  it('does not forward a stale disconnect snapshot from the target protocol when switching back', async () => {
    const facade = new CoyoteProtocolAdapter();
    const forwarded: Array<{ connected: boolean; deviceName: string | undefined }> = [];
    facade.subscribe((state) => {
      forwarded.push({
        connected: state.connected,
        deviceName: state.deviceName,
      });
    });

    const v3Write = new MockCharacteristic(async () => undefined);
    const v3Notify = new MockCharacteristic(async () => undefined);
    const v2Strength = new MockResponseOnlyCharacteristic(async () => undefined);
    const v2WaveA = new MockResponseOnlyCharacteristic(async () => undefined);
    const v2WaveB = new MockResponseOnlyCharacteristic(async () => undefined);

    const v3Context = {
      device: { name: '47L121000', id: 'v3-first' } as unknown as EventTarget & {
        id?: string;
        name?: string;
      },
      server: {
        connected: true,
        async getPrimaryService(service: string) {
          if (service !== V3_PRIMARY_SERVICE) {
            throw new Error('battery unavailable');
          }
          return {
            async getCharacteristic(characteristic: string) {
              if (characteristic === V3_WRITE_CHAR) return v3Write;
              if (characteristic === V3_NOTIFY_CHAR) return v3Notify;
              throw new Error(`unknown V3 characteristic: ${characteristic}`);
            },
          };
        },
      },
    };

    const v2Context = {
      device: { name: 'D-LAB ESTIM01', id: 'v2-middle' } as unknown as EventTarget & {
        id?: string;
        name?: string;
      },
      server: {
        connected: true,
        async getPrimaryService(service: string) {
          if (service !== V2_PRIMARY_SERVICE) {
            throw new Error('battery unavailable');
          }
          return {
            async getCharacteristic(characteristic: string) {
              if (characteristic === V2_STRENGTH_CHAR) return v2Strength;
              if (characteristic === V2_WAVE_A_CHAR) return v2WaveA;
              if (characteristic === V2_WAVE_B_CHAR) return v2WaveB;
              throw new Error(`unknown V2 characteristic: ${characteristic}`);
            },
          };
        },
      },
    };

    const v3ReturnContext = {
      device: { name: '47L121000', id: 'v3-second' } as unknown as EventTarget & {
        id?: string;
        name?: string;
      },
      server: v3Context.server,
    };

    await facade.onConnected(v3Context);
    await facade.onConnected(v2Context);

    forwarded.length = 0;
    await facade.onConnected(v3ReturnContext);

    expect(forwarded.length).toBeGreaterThanOrEqual(2);
    expect(forwarded.some((event) => !event.connected && event.deviceName === '47L121000')).toBe(
      false,
    );
  });

  it('rejects a non-Coyote device instead of silently routing it to the V3 adapter', async () => {
    // Paw-prints/civet-edging/opossum share Coyote V3's exact GATT skeleton,
    // so without this check a device of one of those kinds would silently
    // get CoyoteV3ProtocolAdapter and receive Coyote-shaped B0/BF writes.
    const facade = new CoyoteProtocolAdapter();

    await expect(
      facade.onConnected({
        device: { name: '47L120300', id: 'paw-prints-device' } as unknown as EventTarget & {
          id?: string;
          name?: string;
        },
        server: {
          connected: true,
          async getPrimaryService() {
            throw new Error('should never be reached — createProtocol should throw first');
          },
        },
      }),
    ).rejects.toThrow(/paw-prints/);
  });
});
