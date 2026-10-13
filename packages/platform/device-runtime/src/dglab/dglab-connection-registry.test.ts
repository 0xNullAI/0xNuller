import { afterEach, describe, expect, it } from 'vitest';
import {
  createEmptyDeviceState,
  createEmptySensorState,
  type DeviceCommand,
  type DeviceKind,
  type DeviceState,
  type OpossumCommand,
  type SensorState,
} from '@dg-kit/core';
import {
  createEmptyOpossumState,
  type BluetoothDeviceLike,
  type BluetoothRemoteGATTServerLike,
  type OpossumState,
  type RequestedDevice,
} from '@dg-kit/protocol';
import { allConnectedDevices, grantDeviceLease, safetySessionById } from '@dg-kit/safety';
import { DEFAULT_DEVICE_SAFETY } from '@0xnullai/settings';
import { DGLAB_SAFETY_SESSION_ID, DgLabConnectionRegistry } from './dglab-connection-registry.js';
import type {
  DgLabCoyoteClient,
  DgLabOpossumClient,
  DgLabSensorClient,
  DgLabTransport,
} from './dglab-transport.js';

const server = {} as BluetoothRemoteGATTServerLike;
const wave = { id: 'w', name: 'w', frames: [[10, 50]] as [number, number][] };
const start = (strength: number): DeviceCommand => ({
  type: 'start',
  channel: 'A',
  strength,
  waveform: wave,
  loop: true,
});

function fakeDevice(name: string, id?: string): BluetoothDeviceLike {
  const gatt = {
    connected: true,
    connect: async () => server,
    disconnect: () => {
      gatt.connected = false;
    },
  };
  return Object.assign(new EventTarget(), { name, id, gatt });
}

class FakeOutputClient<TState extends { connected: boolean }, TCommand> {
  readonly writes: TCommand[] = [];
  stops = 0;
  stopError: Error | null = null;
  private readonly listeners = new Set<(state: TState) => void>();

  constructor(
    readonly name: string,
    readonly log: string[],
    public state: TState,
    private readonly zero: (state: TState) => TState,
    private readonly apply: (state: TState, command: TCommand) => TState,
  ) {}

  async connectDevice(device: BluetoothDeviceLike): Promise<void> {
    this.log.push(`attach:${this.name}`);
    this.set({ ...this.state, connected: true, deviceName: device.name });
  }
  async disconnect(): Promise<void> {
    this.log.push(`disconnect:${this.name}`);
    this.set({ ...this.zero(this.state), connected: false });
  }
  async getState(): Promise<TState> {
    return { ...this.state };
  }
  async execute(command: TCommand): Promise<{ state: TState }> {
    this.log.push(`write:${this.name}`);
    this.writes.push(command);
    this.set(this.apply(this.state, command));
    return { state: { ...this.state } };
  }
  async emergencyStop(): Promise<void> {
    this.stops += 1;
    this.log.push(`stop:${this.name}`);
    if (this.stopError) throw this.stopError;
    this.set(this.zero(this.state));
  }
  async setIndicatorColor(): Promise<void> {}
  onStateChanged(listener: (state: TState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Passive link loss, as the transport reports it. */
  drop(): void {
    this.set({ ...this.state, connected: false });
  }
  set(state: TState): void {
    this.state = state;
    for (const listener of this.listeners) listener({ ...state });
  }
}

type FakeCoyote = FakeOutputClient<DeviceState, DeviceCommand>;
type FakeOpossum = FakeOutputClient<OpossumState, OpossumCommand>;

function fakeTransport() {
  const log: string[] = [];
  const picks: RequestedDevice[] = [];
  const coyotes: FakeCoyote[] = [];
  const opossums: FakeOpossum[] = [];
  const created: DeviceKind[] = [];
  let requests = 0;
  const transport: DgLabTransport = {
    requestDevice: async () => {
      requests += 1;
      const next = picks.shift();
      if (!next) throw new Error('no pick queued');
      return next;
    },
    createCoyoteClient: () => {
      created.push('coyote');
      const client: FakeCoyote = new FakeOutputClient(
        `coyote${coyotes.length}`,
        log,
        { ...createEmptyDeviceState() },
        (state) => ({
          ...state,
          strengthA: 0,
          strengthB: 0,
          waveActiveA: false,
          waveActiveB: false,
        }),
        (state, command) =>
          command.type === 'start'
            ? { ...state, strengthA: command.strength, waveActiveA: true }
            : state,
      );
      coyotes.push(client);
      return client as unknown as DgLabCoyoteClient;
    },
    createOpossumClient: () => {
      created.push('opossum');
      const client: FakeOpossum = new FakeOutputClient(
        `opossum${opossums.length}`,
        log,
        createEmptyOpossumState(),
        (state) => ({ ...state, intensityA: 0, intensityB: 0 }),
        (state, command) =>
          command.type === 'vibrateStart' ? { ...state, intensityA: command.intensity } : state,
      );
      opossums.push(client);
      return client as unknown as DgLabOpossumClient;
    },
    createSensorClient: (kind) => {
      created.push(kind);
      const sensor = new FakeOutputClient<SensorState, never>(
        kind,
        log,
        createEmptySensorState(),
        (state) => state,
        (state) => state,
      );
      return Object.assign(sensor, {
        subscribe: () => () => undefined,
      }) as unknown as DgLabSensorClient;
    },
  };
  return {
    transport,
    log,
    coyotes,
    opossums,
    created,
    requests: () => requests,
    pick(kind: DeviceKind, device: BluetoothDeviceLike) {
      picks.push({ kind, device, server });
    },
  };
}

const registries: DgLabConnectionRegistry[] = [];

function setup() {
  const fake = fakeTransport();
  let sequence = 0;
  const registry = new DgLabConnectionRegistry({
    transport: fake.transport,
    limits: () => DEFAULT_DEVICE_SAFETY,
    createId: (kind) => `${kind}/${(sequence += 1)}`,
  });
  registries.push(registry);
  return { fake, registry };
}

afterEach(async () => {
  while (registries.length) await registries.pop()?.dispose();
  await grantDeviceLease(null);
});

describe('DgLabConnectionRegistry', () => {
  it('accepts stops from a non-holder and with no lease, and rejects their output', async () => {
    const { fake, registry } = setup();
    fake.pick('coyote', fakeDevice('47L121000'));
    const { id } = await registry.connect();
    const chat = registry.forModule('chat');

    await expect(chat.execute(id, start(5))).rejects.toMatchObject({ code: 'lease-not-held' });
    await chat.execute(id, { type: 'stop' });
    await chat.emergencyStop(id);
    await grantDeviceLease('agent');
    await chat.execute(id, { type: 'stop', channel: 'A' });
    await expect(chat.execute(id, start(5))).rejects.toMatchObject({ code: 'lease-not-held' });

    expect(fake.coyotes[0]!.writes).toEqual([{ type: 'stop' }, { type: 'stop', channel: 'A' }]);
  });

  it('while held for the background, admits only commands that stop or lower output', async () => {
    const { fake, registry } = setup();
    fake.pick('coyote', fakeDevice('47L121000'));
    fake.pick('opossum', fakeDevice('47L127000'));
    const coyote = await registry.connect();
    const opossum = await registry.connect();
    await grantDeviceLease('agent');
    const agent = registry.forModule('agent');
    await agent.execute(coyote.id, start(5));
    const events: unknown[] = [];
    agent.onBackground((event) => events.push(event));

    registry.holdForBackground(10_000, 1_000);

    await expect(agent.execute(coyote.id, start(8))).rejects.toMatchObject({
      code: 'background-hold',
    });
    await expect(
      agent.execute(coyote.id, { type: 'adjustStrength', channel: 'A', delta: 2 }),
    ).rejects.toMatchObject({ code: 'background-hold' });
    await expect(
      agent.execute(coyote.id, { type: 'burst', channel: 'A', strength: 9, durationMs: 1_000 }),
    ).rejects.toMatchObject({ code: 'background-hold' });
    await expect(
      agent.executeOpossum(opossum.id, { type: 'vibrateStart', channel: 'A', intensity: 5 }),
    ).rejects.toMatchObject({ code: 'background-hold' });
    await agent.execute(coyote.id, { type: 'adjustStrength', channel: 'A', delta: -2 });
    await agent.execute(coyote.id, { type: 'stop', channel: 'A' });
    await agent.executeOpossum(opossum.id, { type: 'vibrateAdjust', channel: 'A', delta: -1 });

    registry.resumeForeground(2_000);
    await agent.execute(coyote.id, start(5));

    expect(fake.coyotes[0]!.writes.map((command) => command.type)).toEqual([
      'start',
      'adjustStrength',
      'stop',
      'start',
    ]);
    expect(events).toEqual([
      { type: 'kept', at: 1_000, until: 10_000 },
      { type: 'foreground', at: 2_000 },
    ]);
  });

  it('a background stop stops every output and tells every module why', async () => {
    const { fake, registry } = setup();
    fake.pick('coyote', fakeDevice('47L121000'));
    await registry.connect();
    const events: unknown[] = [];
    registry.forModule('chat').onBackground((event) => events.push(event));
    const stopsBefore = fake.coyotes[0]!.stops;

    await registry.stopForBackground('background-timeout', 5_000);

    expect(fake.coyotes[0]!.stops).toBe(stopsBefore + 1);
    expect(events).toEqual([{ type: 'stopped', at: 5_000, reason: 'background-timeout' }]);
  });

  it('writes a raw 200 from a module as the device-safety cap', async () => {
    const { fake, registry } = setup();
    fake.pick('coyote', fakeDevice('47L121000'));
    fake.pick('opossum', fakeDevice('47L127000'));
    const coyote = await registry.connect();
    const opossum = await registry.connect();
    await grantDeviceLease('agent');
    const agent = registry.forModule('agent');

    await agent.execute(coyote.id, start(200));
    await agent.execute(coyote.id, {
      type: 'burst',
      channel: 'A',
      strength: 200,
      durationMs: 60_000,
    });
    await agent.executeOpossum(opossum.id, { type: 'vibrateStart', channel: 'A', intensity: 200 });

    expect(fake.coyotes[0]!.writes[0]).toMatchObject({ type: 'start', strength: 50 });
    expect(fake.coyotes[0]!.writes[1]).toMatchObject({ strength: 50, durationMs: 5_000 });
    expect(fake.opossums[0]!.writes[0]).toMatchObject({ intensity: 50 });
  });

  it('stopAll reaches every Coyote and Opossum when one of them throws', async () => {
    const { fake, registry } = setup();
    fake.pick('coyote', fakeDevice('47L121000', 'a'));
    fake.pick('coyote', fakeDevice('47L121000', 'b'));
    fake.pick('opossum', fakeDevice('47L127000', 'c'));
    for (let index = 0; index < 3; index += 1) await registry.connect();
    const [first, second] = fake.coyotes;
    const stopsBefore = [first!.stops, second!.stops, fake.opossums[0]!.stops];
    first!.stopError = new Error('link gone');

    const result = await registry.stopAll();

    expect(result.attempted).toBe(3);
    expect(result.failed).toHaveLength(1);
    expect(second!.stops).toBe(stopsBefore[1]! + 1);
    expect(fake.opossums[0]!.stops).toBe(stopsBefore[2]! + 1);
  });

  it('gives a device picked by two modules one adapter and one id', async () => {
    const { fake, registry } = setup();
    const device = fakeDevice('47L121000', 'addr-1');
    fake.pick('coyote', device);
    fake.pick('coyote', device);

    const fromAgent = await registry.forModule('agent').connect();
    const fromVoice = await registry.forModule('voice').connect();

    expect(fake.created).toEqual(['coyote']);
    expect(fromVoice.id).toBe(fromAgent.id);
    expect(device.gatt?.connected).toBe(true);
    expect(registry.list()).toHaveLength(1);
  });

  it('dedupes by address when the transport hands back a new object, never by name', async () => {
    const { fake, registry } = setup();
    fake.pick('coyote', fakeDevice('47L121000', 'addr-1'));
    fake.pick('coyote', fakeDevice('47L121000', 'addr-1'));
    fake.pick('coyote', fakeDevice('47L121000', 'addr-2'));
    const first = await registry.connect();
    const same = await registry.connect();
    const other = await registry.connect();

    expect(same.id).toBe(first.id);
    expect(other.id).not.toBe(first.id);
    expect(fake.created).toEqual(['coyote', 'coyote']);
  });

  it('opens one picker for concurrent connects', async () => {
    const { fake, registry } = setup();
    fake.pick('coyote', fakeDevice('47L121000'));
    const [a, b] = await Promise.all([registry.connect(), registry.connect()]);

    expect(fake.requests()).toBe(1);
    expect(b.id).toBe(a.id);
  });

  it('stops a device before it disconnects it', async () => {
    const { fake, registry } = setup();
    fake.pick('coyote', fakeDevice('47L121000'));
    const { id } = await registry.connect();
    fake.log.length = 0;

    await registry.disconnect(id);

    expect(fake.log).toEqual(['stop:coyote0', 'disconnect:coyote0']);
    expect(registry.list()).toEqual([]);
  });

  it('keeps the id across a reconnect and zeroes output on every attach', async () => {
    const { fake, registry } = setup();
    const device = fakeDevice('47L121000', 'addr-1');
    fake.pick('coyote', device);
    const { id } = await registry.connect();
    expect(fake.log).toEqual(['attach:coyote0', expect.stringMatching(/^stop:/), 'stop:coyote0']);

    await grantDeviceLease('agent');
    await registry.forModule('agent').execute(id, start(20));
    fake.coyotes[0]!.drop();
    // A V3 host keeps its last strength across the drop.
    fake.coyotes[0]!.state = { ...fake.coyotes[0]!.state, strengthA: 20, waveActiveA: true };
    fake.log.length = 0;
    fake.pick('coyote', device);
    const again = await registry.connect();

    expect(again.id).toBe(id);
    expect(fake.created).toEqual(['coyote']);
    expect(fake.log[0]).toBe('attach:coyote0');
    expect(fake.log).toContain('stop:coyote0');
    expect(fake.coyotes[0]!.state.strengthA).toBe(0);
  });

  it('stops output on a lease switch and revokes only the losing module, without disconnecting', async () => {
    const { fake, registry } = setup();
    fake.pick('coyote', fakeDevice('47L121000'));
    const { id } = await registry.connect();
    const agent = registry.forModule('agent');
    const revoked: string[] = [];
    agent.onRevoked(() => revoked.push('agent'));
    registry.forModule('chat').onRevoked(() => revoked.push('chat'));
    await grantDeviceLease('agent');
    await agent.execute(id, start(20));
    const stops = fake.coyotes[0]!.stops;

    await grantDeviceLease('chat');
    await Promise.resolve();
    await Promise.resolve();

    expect(fake.coyotes[0]!.stops).toBeGreaterThan(stops);
    expect(fake.coyotes[0]!.state.strengthA).toBe(0);
    expect(revoked).toEqual(['agent']);
    expect(fake.log).not.toContain('disconnect:coyote0');
    await expect(agent.execute(id, start(5))).rejects.toMatchObject({ code: 'lease-not-held' });
  });

  it('registers one safety session that lists each physical device once and stops them all', async () => {
    const { fake, registry } = setup();
    fake.pick('coyote', fakeDevice('47L121000', 'a'));
    fake.pick('opossum', fakeDevice('47L127000', 'b'));
    fake.pick('coyote', fakeDevice('47L121000', 'a'));
    await registry.connect();
    await registry.connect();
    await registry.forModule('voice').connect();

    const groups = allConnectedDevices().filter(
      (group) => group.sessionId === DGLAB_SAFETY_SESSION_ID,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.devices.map((device) => device.kind)).toEqual(['coyote', 'opossum']);

    const stops = fake.coyotes[0]!.stops + fake.opossums[0]!.stops;
    await safetySessionById(DGLAB_SAFETY_SESSION_ID)!.stop();
    expect(fake.coyotes[0]!.stops + fake.opossums[0]!.stops).toBe(stops + 2);
  });
});
