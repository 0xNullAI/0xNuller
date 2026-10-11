import { afterEach, describe, expect, it } from 'vitest';
import {
  createEmptyDeviceState,
  type DeviceCommand,
  type DeviceCommandResult,
  type DeviceState,
} from '@dg-kit/core';
import type { BluetoothDeviceLike, BluetoothRemoteGATTServerLike } from '@dg-kit/protocol';
import { grantDeviceLease } from '@dg-kit/safety';
import { DEFAULT_DEVICE_SAFETY } from '@0xnullai/settings';
import { DgLabConnectionRegistry } from './dglab-connection-registry.js';
import type { DgLabCoyoteClient, DgLabTransport } from './dglab-transport.js';

/** Coyote client whose next state read can be held open, to park a command mid-admission. */
class GatedCoyote implements DgLabCoyoteClient {
  state: DeviceState = createEmptyDeviceState();
  readonly writes: DeviceCommand[] = [];
  stops = 0;
  disconnects = 0;
  private gate: Promise<void> | null = null;
  private release: (() => void) | null = null;
  private entered: (() => void) | null = null;
  /** Resolves once the held read is in progress, i.e. the command passed queue admission. */
  readHeld: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(state: DeviceState) => void>();

  holdNextStateRead(): () => void {
    this.gate = new Promise((resolve) => {
      this.release = resolve;
    });
    this.readHeld = new Promise((resolve) => {
      this.entered = resolve;
    });
    return () => this.release?.();
  }
  async connect(): Promise<void> {
    throw new Error('the registry attaches picked devices; it never opens a second chooser');
  }
  async connectDevice(): Promise<void> {
    this.set({ ...this.state, connected: true });
  }
  async disconnect(): Promise<void> {
    this.disconnects += 1;
    this.set({ ...this.state, connected: false });
  }
  async getState(): Promise<DeviceState> {
    const gate = this.gate;
    this.gate = null;
    if (gate) {
      this.entered?.();
      await gate;
    }
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

const wave = { id: 'w', name: 'w', frames: [[10, 50]] as [number, number][] };
const start = (strength: number): DeviceCommand => ({
  type: 'start',
  channel: 'A',
  strength,
  waveform: wave,
  loop: true,
});

let registry: DgLabConnectionRegistry | null = null;

afterEach(async () => {
  await registry?.dispose();
  registry = null;
  await grantDeviceLease(null);
});

async function connectedCoyote() {
  const client = new GatedCoyote();
  const device = Object.assign(new EventTarget(), {
    name: '47L121000',
    id: 'addr-1',
    gatt: { connected: true, connect: async () => ({}), disconnect: () => undefined },
  }) as BluetoothDeviceLike;
  const transport: DgLabTransport = {
    requestDevice: async () => ({
      kind: 'coyote',
      device,
      server: {} as BluetoothRemoteGATTServerLike,
    }),
    createCoyoteClient: () => client,
    createOpossumClient: () => {
      throw new Error('not used');
    },
    createSensorClient: () => {
      throw new Error('not used');
    },
  };
  registry = new DgLabConnectionRegistry({ transport, limits: () => DEFAULT_DEVICE_SAFETY });
  const { id } = await registry.connect();
  return { client, id, registry };
}

describe('DG-Lab registry under the real safety-bus lease', () => {
  it('writes nothing after the epoch bump for commands admitted or queued before it', async () => {
    const { client, id, registry } = await connectedCoyote();
    await grantDeviceLease('agent');
    const agent = registry.forModule('agent');
    const revoked: string[] = [];
    agent.onRevoked(() => revoked.push('agent'));

    const release = client.holdNextStateRead();
    const admitted = agent.execute(id, start(20));
    const queued = agent.execute(id, { type: 'adjustStrength', channel: 'A', delta: 5 });
    await client.readHeld;
    const writesBeforeSwitch = client.writes.length;

    await grantDeviceLease('chat');
    release();

    await expect(admitted).rejects.toMatchObject({ code: 'lease-changed' });
    await expect(queued).resolves.toMatchObject({ interrupted: true });
    expect(client.writes.length).toBe(writesBeforeSwitch);
    expect(revoked).toEqual(['agent']);
  });

  it('stops live output on the switch and keeps the link', async () => {
    const { client, id, registry } = await connectedCoyote();
    await grantDeviceLease('agent');
    await registry.forModule('agent').execute(id, start(30));
    expect(client.state.strengthA).toBe(30);
    const stops = client.stops;

    await grantDeviceLease('chat');

    expect(client.stops).toBe(stops + 1);
    expect(client.state.strengthA).toBe(0);
    expect(client.disconnects).toBe(0);
    expect(registry.list()[0]).toMatchObject({ id, connected: true });
  });

  it('fences the agent → chat → agent round trip (ABA)', async () => {
    const { client, id, registry } = await connectedCoyote();
    await grantDeviceLease('agent');
    const release = client.holdNextStateRead();
    const stale = registry.forModule('agent').execute(id, start(20));
    await client.readHeld;

    await grantDeviceLease('chat');
    await grantDeviceLease('agent');
    release();

    await expect(stale).rejects.toMatchObject({ code: 'lease-changed' });
    expect(client.writes).toEqual([]);
    await registry.forModule('agent').execute(id, start(20));
    expect(client.writes).toHaveLength(1);
  });
});
