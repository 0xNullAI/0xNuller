import { afterEach, describe, expect, it } from 'vitest';
import {
  createEmptyDeviceState,
  type DeviceCommand,
  type DeviceCommandResult,
  type DeviceState,
} from '@dg-kit/core';
import type { BluetoothDeviceLike, BluetoothRemoteGATTServerLike } from '@dg-kit/protocol';
import { grantDeviceLease } from '@dg-kit/safety';
import {
  DgLabConnectionRegistry,
  type DgLabCoyoteClient,
  type DgLabTransport,
} from '@0xnullai/device-runtime';
import { DEFAULT_DEVICE_SAFETY } from '@0xnullai/settings';
import { DeviceSession, createRegistryTransport } from './device-session.js';

/** Boundary fake for the one adapter the registry builds per physical Coyote. */
class FakeCoyote implements DgLabCoyoteClient {
  state: DeviceState = createEmptyDeviceState();
  readonly writes: DeviceCommand[] = [];
  stops = 0;
  disconnects = 0;
  private readonly listeners = new Set<(state: DeviceState) => void>();

  async connect(): Promise<void> {
    throw new Error('the registry attaches picked devices; Voice never opens a chooser');
  }
  async connectDevice(): Promise<void> {
    this.set({ ...this.state, connected: true, deviceName: '47L121000' });
  }
  async disconnect(): Promise<void> {
    this.disconnects += 1;
    this.set({ ...this.state, connected: false });
  }
  async getState(): Promise<DeviceState> {
    return { ...this.state };
  }
  async execute(command: DeviceCommand): Promise<DeviceCommandResult> {
    this.writes.push(command);
    if (command.type === 'start') {
      this.set({ ...this.state, strengthA: command.strength, waveActiveA: true });
    }
    return { state: { ...this.state } };
  }
  async emergencyStop(): Promise<void> {
    this.stops += 1;
    this.set({ ...this.state, strengthA: 0, strengthB: 0, waveActiveA: false, waveActiveB: false });
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

const start: DeviceCommand = {
  type: 'start',
  channel: 'A',
  strength: 20,
  waveform: { id: 'w', name: 'w', frames: [[10, 50]] },
  loop: true,
};

let registry: DgLabConnectionRegistry | null = null;

afterEach(async () => {
  await registry?.dispose();
  registry = null;
  await grantDeviceLease(null);
});

function sharedRegistry() {
  const coyote = new FakeCoyote();
  let picks = 0;
  const device = Object.assign(new EventTarget(), {
    name: '47L121000',
    id: 'addr-1',
    gatt: { connected: true, connect: async () => ({}), disconnect: () => undefined },
  }) as BluetoothDeviceLike;
  const transport: DgLabTransport = {
    requestDevice: async () => {
      picks += 1;
      return { kind: 'coyote', device, server: {} as BluetoothRemoteGATTServerLike };
    },
    createCoyoteClient: () => coyote,
    createOpossumClient: () => {
      throw new Error('not used');
    },
    createSensorClient: () => {
      throw new Error('not used');
    },
  };
  registry = new DgLabConnectionRegistry({ transport, limits: () => DEFAULT_DEVICE_SAFETY });
  return { coyote, registry, picks: () => picks };
}

describe('Voice on the shared DG-Lab registry', () => {
  it('drives a device another module connected while Voice holds the lease, then is fenced off', async () => {
    const { coyote, registry, picks } = sharedRegistry();
    // Control opens the one link; Voice opens none of its own.
    const { id } = await registry.forModule('control').connect();
    const session = new DeviceSession(createRegistryTransport(registry.forModule('voice')));
    const revoked: string[] = [];
    session.onRevoked(() => revoked.push('voice'));

    const targets = await session.listCoyoteTargets();
    expect(targets.map(({ targetId }) => targetId)).toEqual([id]);

    await grantDeviceLease('voice');
    await expect(session.coyoteTargetRouter.executeTarget(id, start)).resolves.toBeTruthy();
    expect(coyote.writes).toHaveLength(1);
    expect(coyote.state.strengthA).toBe(20);
    const stopsBefore = coyote.stops;

    await grantDeviceLease('control');

    // The switch stops output, tells Voice, and keeps the link for the new holder.
    expect(coyote.stops).toBeGreaterThan(stopsBefore);
    expect(coyote.state.strengthA).toBe(0);
    expect(revoked).toEqual(['voice']);
    expect(coyote.disconnects).toBe(0);
    await expect(session.coyoteTargetRouter.executeTarget(id, start)).rejects.toMatchObject({
      code: 'lease-not-held',
    });
    expect(coyote.writes).toHaveLength(1);

    // Stop stays reachable without the lease.
    await expect(session.emergencyStop()).resolves.toBeUndefined();
    expect(picks()).toBe(1);
  });
});
