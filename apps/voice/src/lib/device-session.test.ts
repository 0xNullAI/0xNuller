import { createEmptyDeviceState, type DeviceCommand, type DeviceState } from '@dg-kit/core';
import type { BluetoothDeviceLike, BluetoothRemoteGATTServerLike } from '@dg-kit/protocol';
import { grantDeviceLease } from '@dg-kit/safety';
import {
  DgLabConnectionRegistry,
  type DgLabCoyoteClient,
  type DgLabTransport,
} from '@0xnullai/device-runtime';
import { DEFAULT_DEVICE_SAFETY } from '@0xnullai/settings';
import { afterEach, describe, expect, it } from 'vitest';
import { DeviceSession, createRegistryTransport } from './device-session.js';

/** Boundary fake for the one adapter the registry builds per physical Coyote. */
class FakeCoyote implements DgLabCoyoteClient {
  state: DeviceState = createEmptyDeviceState();
  readonly writes: DeviceCommand[] = [];
  private readonly listeners = new Set<(state: DeviceState) => void>();

  async connect(): Promise<void> {
    throw new Error('the registry attaches picked devices');
  }
  async connectDevice(device: BluetoothDeviceLike): Promise<void> {
    this.set({ ...this.state, connected: true, deviceName: device.name });
  }
  async disconnect(): Promise<void> {
    this.set({ ...this.state, connected: false });
  }
  async getState(): Promise<DeviceState> {
    return { ...this.state };
  }
  async execute(command: DeviceCommand) {
    this.writes.push(command);
    return { state: { ...this.state } };
  }
  async emergencyStop(): Promise<void> {
    this.set({ ...this.state, strengthA: 0, strengthB: 0 });
  }
  onStateChanged(listener: (state: DeviceState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private set(state: DeviceState): void {
    this.state = state;
    for (const listener of this.listeners) listener({ ...state });
  }
}

let registry: DgLabConnectionRegistry | null = null;

afterEach(async () => {
  await registry?.dispose();
  registry = null;
  await grantDeviceLease(null);
});

/** Two physical Coyotes that advertise the same name. */
function twoSameNameCoyotes() {
  const children: FakeCoyote[] = [];
  const picked = [1, 2].map(
    (number) =>
      Object.assign(new EventTarget(), {
        id: `native-${number}`,
        name: 'Same advertised name',
        gatt: { connected: true, connect: async () => ({}), disconnect: () => undefined },
      }) as BluetoothDeviceLike,
  );
  let pickIndex = 0;
  let sequence = 0;
  const transport: DgLabTransport = {
    requestDevice: async () => ({
      kind: 'coyote',
      device: picked[pickIndex++]!,
      server: {} as BluetoothRemoteGATTServerLike,
    }),
    createCoyoteClient: () => {
      const child = new FakeCoyote();
      children.push(child);
      return child;
    },
    createOpossumClient: () => {
      throw new Error('not used');
    },
    createSensorClient: () => {
      throw new Error('not used');
    },
  };
  registry = new DgLabConnectionRegistry({
    transport,
    limits: () => DEFAULT_DEVICE_SAFETY,
    createId: (kind) => `${kind}/opaque-${++sequence}`,
  });
  const session = new DeviceSession(createRegistryTransport(registry.forModule('voice')));
  return { session, children };
}

describe('Voice multi-Coyote identity and routing', () => {
  it('keeps two same-kind same-name devices as separate opaque targets', async () => {
    const { session, children } = twoSameNameCoyotes();

    await session.connectDevice();
    await session.connectDevice();
    const targets = await session.listCoyoteTargets();

    expect(children).toHaveLength(2);
    expect(targets.map(({ targetId }) => targetId)).toEqual(['coyote/opaque-1', 'coyote/opaque-2']);
    expect(targets[0]?.state.deviceName).toBe(targets[1]?.state.deviceName);
    expect(targets.map(({ targetId }) => targetId).join()).not.toContain('native-');
    expect(targets.map(({ targetId }) => targetId).join()).not.toContain('Same advertised name');
  });

  it('executes on one exact same-name target without selecting or fanning out', async () => {
    const { session, children } = twoSameNameCoyotes();
    await session.connectDevice();
    await session.connectDevice();
    const [, second] = await session.listCoyoteTargets();
    await grantDeviceLease('voice');

    await session.coyoteTargetRouter.executeTarget(second!.targetId, {
      type: 'adjustStrength',
      channel: 'A',
      delta: 1,
    });

    expect(children[0]!.writes).toHaveLength(0);
    expect(children[1]!.writes).toHaveLength(1);
  });
});
