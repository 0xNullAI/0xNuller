import { afterEach, describe, expect, it } from 'vitest';
import {
  createEmptyDeviceState,
  type DeviceCommand,
  type DeviceState,
  type OpossumCommand,
} from '@dg-kit/core';
import {
  createEmptyOpossumState,
  type BluetoothDeviceLike,
  type BluetoothRemoteGATTServerLike,
  type OpossumState,
  type RequestedDevice,
} from '@dg-kit/protocol';
import { grantDeviceLease } from '@dg-kit/safety';
import { DEFAULT_DEVICE_SAFETY } from '@0xnullai/settings';
import { DgLabConnectionRegistry, type DgLabModuleHandle } from './dglab-connection-registry.js';
import type { DgLabCoyoteClient, DgLabOpossumClient, DgLabTransport } from './dglab-transport.js';
import { RegistryCoyoteClient, RegistryOpossumClient } from './registry-clients.js';

function recordingClient<TState extends { connected: boolean }, TCommand>(initial: TState) {
  const listeners = new Set<(state: TState) => void>();
  const record = {
    state: initial,
    writes: [] as TCommand[],
    stops: 0,
    async connectDevice() {
      record.state = { ...record.state, connected: true };
      for (const listener of listeners) listener(record.state);
    },
    async disconnect() {
      record.state = { ...record.state, connected: false };
    },
    async getState() {
      return { ...record.state };
    },
    async execute(command: TCommand) {
      record.writes.push(command);
      return { state: { ...record.state } };
    },
    async emergencyStop() {
      record.stops += 1;
    },
    async setIndicatorColor() {},
    onStateChanged(listener: (state: TState) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return record;
}

const picks: RequestedDevice[] = [];
const coyote = recordingClient<DeviceState, DeviceCommand>(createEmptyDeviceState());
const opossum = recordingClient<OpossumState, OpossumCommand>(createEmptyOpossumState());
const transport: DgLabTransport = {
  requestDevice: async () => picks.shift()!,
  createCoyoteClient: () => coyote as unknown as DgLabCoyoteClient,
  createOpossumClient: () => opossum as unknown as DgLabOpossumClient,
  createSensorClient: () => {
    throw new Error('not used');
  },
};

function pick(kind: 'coyote' | 'opossum', id: string) {
  const device = Object.assign(new EventTarget(), {
    name: kind === 'coyote' ? '47L121000' : '47L127000',
    id,
    gatt: { connected: true, connect: async () => ({}), disconnect: () => undefined },
  }) as BluetoothDeviceLike;
  picks.push({ kind, device, server: {} as BluetoothRemoteGATTServerLike });
}

/** Counts every call the module-facing clients make, to prove nothing bypasses the handle. */
function countingHandle(handle: DgLabModuleHandle) {
  const calls: string[] = [];
  const counted = new Proxy(handle, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push(String(key));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { calls, counted };
}

let registry: DgLabConnectionRegistry | null = null;

afterEach(async () => {
  await registry?.dispose();
  registry = null;
  await grantDeviceLease(null);
  coyote.writes.length = 0;
  opossum.writes.length = 0;
});

describe('registry module clients', () => {
  it('route every Coyote write through the fenced handle', async () => {
    registry = new DgLabConnectionRegistry({ transport, limits: () => DEFAULT_DEVICE_SAFETY });
    const { calls, counted } = countingHandle(registry.forModule('agent'));
    const client = new RegistryCoyoteClient(counted);
    pick('coyote', 'addr-1');
    await client.connect();
    const [target] = client.getConnectedCoyotes();
    const start: DeviceCommand = {
      type: 'start',
      channel: 'A',
      strength: 200,
      waveform: { id: 'w', name: 'w', frames: [[10, 50]] },
      loop: true,
    };

    await expect(client.executeDeviceById(target!.id, start)).rejects.toMatchObject({
      code: 'lease-not-held',
    });
    await expect(client.execute(start)).rejects.toMatchObject({ code: 'lease-not-held' });
    expect(coyote.writes).toEqual([]);

    await grantDeviceLease('agent');
    await client.executeDeviceById(target!.id, start);
    expect(coyote.writes).toEqual([{ ...start, strength: 50 }]);
    expect(await client.executeDeviceById('coyote/unknown', start)).toBeNull();

    await grantDeviceLease(null);
    const stops = coyote.stops;
    expect(await client.emergencyStopDeviceById(target!.id)).toBe(true);
    expect(coyote.stops).toBeGreaterThan(stops);

    expect(calls.filter((name) => name === 'execute')).toHaveLength(3);
    expect(calls).toContain('emergencyStop');
  });

  it('route every Opossum write through the fenced handle', async () => {
    registry = new DgLabConnectionRegistry({ transport, limits: () => DEFAULT_DEVICE_SAFETY });
    const { calls, counted } = countingHandle(registry.forModule('voice'));
    const client = new RegistryOpossumClient(counted);
    pick('opossum', 'addr-2');
    await client.connect();

    await expect(
      client.execute({ type: 'vibrateStart', channel: 'B', intensity: 200 }),
    ).rejects.toMatchObject({ code: 'lease-not-held' });
    await expect(client.setIndicatorColor(0xff0000)).rejects.toMatchObject({
      code: 'lease-not-held',
    });
    expect(opossum.writes).toEqual([]);

    await grantDeviceLease('voice');
    await client.execute({ type: 'vibrateStart', channel: 'B', intensity: 200 });
    expect(opossum.writes).toEqual([{ type: 'vibrateStart', channel: 'B', intensity: 50 }]);
    expect(calls.filter((name) => name === 'executeOpossum')).toHaveLength(2);
  });
});
