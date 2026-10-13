import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createEmptyDeviceState,
  type DeviceCommand,
  type DeviceState,
  type OpossumCommand,
} from '@dg-kit/core';
import {
  CoyoteProtocolAdapter,
  createEmptyOpossumState,
  type BluetoothDeviceLike,
  type BluetoothRemoteGATTServerLike,
  type OpossumState,
  type RequestedDevice,
} from '@dg-kit/protocol';
import { allConnectedDevices, grantDeviceLease } from '@dg-kit/safety';
import {
  DEFAULT_DEVICE_SAFETY,
  loadDeviceLimits,
  updateDeviceLimit,
  type DeviceSafetySettings,
} from '@0xnullai/settings';
import { DGLAB_SAFETY_SESSION_ID, DgLabConnectionRegistry } from './dglab-connection-registry.js';
import { deriveDgLabStableKey } from './device-limits.js';
import type { DgLabCoyoteClient, DgLabOpossumClient, DgLabTransport } from './dglab-transport.js';

const server = {} as BluetoothRemoteGATTServerLike;
const wave = { id: 'w', name: 'w', frames: [[10, 50]] as [number, number][] };
const start = (strength: number, channel: 'A' | 'B' = 'A'): DeviceCommand => ({
  type: 'start',
  channel,
  strength,
  waveform: wave,
  loop: true,
});

function bleDevice(name: string, id?: string): BluetoothDeviceLike {
  const gatt = {
    connected: true,
    connect: async () => server,
    disconnect: () => {
      gatt.connected = false;
    },
  };
  return Object.assign(new EventTarget(), { name, id, gatt });
}

/** A client whose state follows each write, with an optional gate to hold a write in flight. */
class FakeClient<TState extends { connected: boolean }, TCommand> {
  readonly writes: TCommand[] = [];
  stops = 0;
  gate: Promise<void> | null = null;
  private readonly listeners = new Set<(state: TState) => void>();

  constructor(
    public state: TState,
    private readonly zero: (state: TState) => TState,
    private readonly apply: (state: TState, command: TCommand) => TState,
  ) {}

  async connectDevice(device: BluetoothDeviceLike): Promise<void> {
    this.set({ ...this.state, connected: true, deviceName: device.name });
  }
  async disconnect(): Promise<void> {
    this.set({ ...this.zero(this.state), connected: false });
  }
  async getState(): Promise<TState> {
    return { ...this.state };
  }
  async execute(command: TCommand): Promise<{ state: TState }> {
    if (this.gate) await this.gate;
    this.writes.push(command);
    this.set(this.apply(this.state, command));
    return { state: { ...this.state } };
  }
  async emergencyStop(): Promise<void> {
    this.stops += 1;
    this.set(this.zero(this.state));
  }
  onStateChanged(listener: (state: TState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  set(state: TState): void {
    this.state = state;
    for (const listener of this.listeners) listener({ ...state });
  }
}

type FakeCoyote = FakeClient<DeviceState, DeviceCommand>;
type FakeOpossum = FakeClient<OpossumState, OpossumCommand>;

function applyCoyote(state: DeviceState, command: DeviceCommand): DeviceState {
  const key = 'channel' in command && command.channel === 'B' ? 'strengthB' : 'strengthA';
  switch (command.type) {
    case 'start':
    case 'burst':
      return { ...state, [key]: command.strength };
    case 'adjustStrength':
      return { ...state, [key]: state[key] + command.delta };
    default:
      return state;
  }
}

function applyOpossum(state: OpossumState, command: OpossumCommand): OpossumState {
  const key = 'channel' in command && command.channel === 'B' ? 'intensityB' : 'intensityA';
  switch (command.type) {
    case 'vibrateStart':
    case 'vibrateBurst':
      return { ...state, [key]: command.intensity };
    case 'vibrateAdjust':
      return { ...state, [key]: state[key] + command.delta };
    default:
      return state;
  }
}

const zeroCoyote = (state: DeviceState): DeviceState => ({ ...state, strengthA: 0, strengthB: 0 });
const zeroOpossum = (state: OpossumState): OpossumState => ({
  ...state,
  intensityA: 0,
  intensityB: 0,
});

function fakeTransport() {
  const picks: RequestedDevice[] = [];
  const coyotes: FakeCoyote[] = [];
  const opossums: FakeOpossum[] = [];
  const transport: DgLabTransport = {
    requestDevice: async () => {
      const next = picks.shift();
      if (!next) throw new Error('no pick queued');
      return next;
    },
    createCoyoteClient: () => {
      const client: FakeCoyote = new FakeClient(createEmptyDeviceState(), zeroCoyote, applyCoyote);
      coyotes.push(client);
      return client as unknown as DgLabCoyoteClient;
    },
    createOpossumClient: () => {
      const client: FakeOpossum = new FakeClient(
        createEmptyOpossumState(),
        zeroOpossum,
        applyOpossum,
      );
      opossums.push(client);
      return client as unknown as DgLabOpossumClient;
    },
    createSensorClient: () => {
      throw new Error('no sensors in these tests');
    },
  };
  return {
    transport,
    coyotes,
    opossums,
    pick(kind: 'coyote' | 'opossum', device: BluetoothDeviceLike) {
      picks.push({ kind, device, server });
    },
  };
}

const registries: DgLabConnectionRegistry[] = [];
let global: DeviceSafetySettings;
const globalListeners = new Set<() => void>();

function setGlobal(patch: Partial<DeviceSafetySettings>): void {
  global = { ...global, ...patch };
  for (const listener of globalListeners) listener();
}

function setup(fake = fakeTransport()) {
  let sequence = 0;
  const registry = new DgLabConnectionRegistry({
    transport: fake.transport,
    limits: () => global,
    subscribeLimits: (listener) => {
      globalListeners.add(listener);
      return () => globalListeners.delete(listener);
    },
    createId: (kind) => `${kind}/${(sequence += 1)}-${registries.length}`,
  });
  registries.push(registry);
  return { fake, registry, control: registry.forModule('control') };
}

/** Let fire-and-forget stops and their state events land. */
async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

beforeEach(async () => {
  localStorage.clear();
  global = { ...DEFAULT_DEVICE_SAFETY };
  await grantDeviceLease('control');
});

afterEach(async () => {
  while (registries.length) await registries.pop()?.dispose();
  globalListeners.clear();
  await grantDeviceLease(null);
  localStorage.clear();
});

describe('per-device limits in the Coyote itself', () => {
  it('writes the effective caps into the device on connect and on every limit change', async () => {
    const setLimits = vi.spyOn(CoyoteProtocolAdapter.prototype, 'setLimits');
    const { fake, registry } = setup();
    fake.pick('coyote', bleDevice('47L121000', 'addr-1'));
    const { id } = await registry.connect();
    expect(setLimits).toHaveBeenLastCalledWith(50, 50);

    await registry.setOwnLimits(id, { a: 20 });
    await vi.waitFor(() => expect(setLimits).toHaveBeenLastCalledWith(20, 50));

    // An unchanged cap is not written again.
    const calls = setLimits.mock.calls.length;
    await registry.setOwnLimits(id, { a: 20 });
    expect(setLimits.mock.calls.length).toBe(calls);
    setLimits.mockRestore();
  });

  it('keeps the connection when the device refuses the limit write', async () => {
    const setLimits = vi
      .spyOn(CoyoteProtocolAdapter.prototype, 'setLimits')
      .mockRejectedValue(new Error('gatt busy'));
    const { fake, registry } = setup();
    fake.pick('coyote', bleDevice('47L121000', 'addr-1'));

    const snapshot = await registry.connect();

    expect(snapshot.connected).toBe(true);
    expect(setLimits.mock.calls.length).toBeGreaterThanOrEqual(3);
    setLimits.mockRestore();
  });
});

describe('per-device limits: holder clamp on every write path', () => {
  it('clamps Coyote start, adjust and burst to the device cap, and refuses a waveform above it', async () => {
    const { fake, registry, control } = setup();
    fake.pick('coyote', bleDevice('47L121000', 'addr-1'));
    const { id } = await registry.connect();
    await registry.setOwnLimits(id, { a: 20, b: 35 });
    const coyote = fake.coyotes[0]!;

    await control.execute(id, start(200));
    expect(coyote.state.strengthA).toBe(20);
    await control.execute(id, { type: 'adjustStrength', channel: 'A', delta: 10 });
    expect(coyote.state.strengthA).toBe(20);
    await control.execute(id, start(200, 'B'));
    expect(coyote.state.strengthB).toBe(35);
    await control.execute(id, { type: 'burst', channel: 'B', strength: 180, durationMs: 500 });
    expect(coyote.writes.at(-1)).toMatchObject({ type: 'burst', strength: 35 });

    // Output left above the cap (a stop that has not landed yet) never gets a new waveform
    // or a burst on top; an adjust is clamped down to the cap instead.
    coyote.state = { ...coyote.state, strengthA: 60 };
    await expect(
      control.execute(id, { type: 'changeWave', channel: 'A', waveform: wave, loop: true }),
    ).rejects.toMatchObject({ code: 'limit-denied' });
    await expect(
      control.execute(id, { type: 'burst', channel: 'A', strength: 10, durationMs: 500 }),
    ).rejects.toMatchObject({ code: 'limit-denied' });
    await control.execute(id, { type: 'adjustStrength', channel: 'A', delta: 5 });
    expect(coyote.state.strengthA).toBe(20);
  });

  it('clamps Opossum start, adjust and burst, and refuses a pattern above the cap', async () => {
    const { fake, registry, control } = setup();
    fake.pick('opossum', bleDevice('47L127000', 'addr-o'));
    const { id } = await registry.connect();
    await registry.setOwnLimits(id, { a: 15, b: 25 });
    const opossum = fake.opossums[0]!;

    await control.executeOpossum(id, { type: 'vibrateStart', channel: 'A', intensity: 200 });
    expect(opossum.state.intensityA).toBe(15);
    await control.executeOpossum(id, { type: 'vibrateAdjust', channel: 'A', delta: 9 });
    expect(opossum.state.intensityA).toBe(15);
    await control.executeOpossum(id, {
      type: 'vibrateBurst',
      channel: 'B',
      intensity: 150,
      durationMs: 400,
    });
    expect(opossum.state.intensityB).toBe(25);

    opossum.state = { ...opossum.state, intensityA: 90 };
    await expect(
      control.executeOpossum(id, { type: 'vibrateSetPattern', channel: 'A', pattern: 'pulse' }),
    ).rejects.toMatchObject({ code: 'limit-denied' });
  });

  it('applies min(global, own): the stricter of the two always wins', async () => {
    const { fake, registry, control } = setup();
    fake.pick('coyote', bleDevice('47L121000', 'addr-1'));
    const { id } = await registry.connect();

    await registry.setOwnLimits(id, { a: 120 });
    await control.execute(id, start(200));
    expect(fake.coyotes[0]!.state.strengthA).toBe(50);

    await control.emergencyStop(id);
    setGlobal({ maxStrengthA: 150 });
    await registry.setOwnLimits(id, { a: 30 });
    await control.execute(id, start(200));
    expect(fake.coyotes[0]!.state.strengthA).toBe(30);

    expect(registry.listDeviceLimits()[0]).toMatchObject({
      ownLimits: { a: 30, b: 200 },
      globalLimits: { a: 150, b: 50 },
      effectiveLimits: { a: 30, b: 50 },
    });
  });

  it('gives two Coyotes their own caps', async () => {
    const { fake, registry, control } = setup();
    fake.pick('coyote', bleDevice('47L121000', 'addr-1'));
    fake.pick('coyote', bleDevice('47L121000', 'addr-2'));
    const first = await registry.connect();
    const second = await registry.connect();
    await registry.setOwnLimits(first.id, { a: 10 });
    await registry.setOwnLimits(second.stableKey, { a: 40 });

    await control.execute(first.id, start(200));
    await control.execute(second.id, start(200));

    expect(fake.coyotes[0]!.state.strengthA).toBe(10);
    expect(fake.coyotes[1]!.state.strengthA).toBe(40);
    // Same name, different devices: never one shared record.
    expect(first.stableKey).not.toBe(second.stableKey);
  });
});

describe('per-device limits: lowering while running', () => {
  it('stops a device whose output is above a lowered own cap, and only that device', async () => {
    const { fake, registry, control } = setup();
    fake.pick('coyote', bleDevice('47L121000', 'addr-1'));
    fake.pick('coyote', bleDevice('47L121000', 'addr-2'));
    const first = await registry.connect();
    const second = await registry.connect();
    await control.execute(first.id, start(40));
    await control.execute(second.id, start(40));
    const [one, two] = fake.coyotes;
    const stops = [one!.stops, two!.stops];

    // Lowering above the running output only caps later writes.
    await registry.setOwnLimits(first.id, { a: 45 });
    expect(one!.stops).toBe(stops[0]);

    await registry.setOwnLimits(first.id, { a: 25 });
    expect(one!.stops).toBe(stops[0]! + 1);
    expect(one!.state.strengthA).toBe(0);
    expect(two!.stops).toBe(stops[1]);
    expect(two!.state.strengthA).toBe(40);
  });

  it('stops an Opossum above a lowered cap', async () => {
    const { fake, registry, control } = setup();
    fake.pick('opossum', bleDevice('47L127000', 'addr-o'));
    const { id } = await registry.connect();
    await control.executeOpossum(id, { type: 'vibrateStart', channel: 'B', intensity: 30 });
    const stops = fake.opossums[0]!.stops;

    await registry.setOwnLimits(id, { b: 5 });

    expect(fake.opossums[0]!.stops).toBe(stops + 1);
    expect(fake.opossums[0]!.state.intensityB).toBe(0);
  });

  it('stops output above a lowered global cap the same way', async () => {
    const { fake, registry, control } = setup();
    fake.pick('coyote', bleDevice('47L121000', 'addr-1'));
    const { id } = await registry.connect();
    await control.execute(id, start(40));
    const stops = fake.coyotes[0]!.stops;

    setGlobal({ maxStrengthA: 20 });
    await settle();

    expect(fake.coyotes[0]!.stops).toBe(stops + 1);
    expect(fake.coyotes[0]!.state.strengthA).toBe(0);
  });

  it('stops only on a lowering, not on an unrelated settings change', async () => {
    const { fake, registry } = setup();
    fake.pick('coyote', bleDevice('47L121000', 'addr-1'));
    const { id } = await registry.connect();
    const coyote = fake.coyotes[0]!;
    // Output above the cap that did not come through the app (the host's own wheel).
    coyote.set({ ...coyote.state, strengthA: 70 });
    const stops = coyote.stops;

    setGlobal({ maxColdStartStrength: 5 });
    await registry.setOwnLimits(id, { b: 150 });
    await settle();
    expect(coyote.stops).toBe(stops);

    await registry.setOwnLimits(id, { a: 45 });
    expect(coyote.stops).toBe(stops + 1);
  });

  it('re-clamps work already queued with the cap read at write time', async () => {
    const { fake, registry, control } = setup();
    fake.pick('coyote', bleDevice('47L121000', 'addr-1'));
    const { id } = await registry.connect();
    const coyote = fake.coyotes[0]!;
    let release!: () => void;
    coyote.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const inFlight = control.execute(id, start(5, 'B'));
    const queued = control.execute(id, start(40));
    await settle();
    await registry.setOwnLimits(id, { a: 25 });
    coyote.gate = null;
    release();
    await Promise.all([inFlight, queued]);

    expect(coyote.writes.at(-1)).toMatchObject({ type: 'start', channel: 'A', strength: 25 });
  });

  it('applies a cap lowered by another tab (storage write) before the next write', async () => {
    const { fake, registry, control } = setup();
    fake.pick('coyote', bleDevice('47L121000', 'addr-1'));
    const { stableKey, id } = await registry.connect();
    // No notification at all: the holder still reads the record at write time.
    localStorage.setItem(
      '0xnullai.device-limits',
      JSON.stringify({ [stableKey]: { kind: 'coyote', a: 12, b: 200 } }),
    );
    await control.execute(id, start(200));
    expect(fake.coyotes[0]!.state.strengthA).toBe(12);
  });
});

describe('per-device limits: identity and persistence', () => {
  it('keeps a cap across a reconnect with a new connection id and across app restarts', async () => {
    const first = setup();
    first.fake.pick('coyote', bleDevice('47L121000', 'addr-1'));
    const before = await first.registry.connect();
    await first.registry.setOwnLimits(before.id, { a: 18, b: 22 });
    await first.registry.disconnect(before.id);

    first.fake.pick('coyote', bleDevice('47L121000', 'addr-1'));
    const after = await first.registry.connect();
    expect(after.id).not.toBe(before.id);
    expect(after.stableKey).toBe(before.stableKey);
    await first.control.execute(after.id, start(200));
    expect(first.fake.coyotes.at(-1)!.state.strengthA).toBe(18);

    // A fresh registry is a restarted app reading the same local settings.
    const restarted = setup();
    restarted.fake.pick('coyote', bleDevice('47L121000', 'addr-1'));
    const again = await restarted.registry.connect();
    await restarted.control.execute(again.id, start(200, 'B'));
    expect(restarted.fake.coyotes[0]!.state.strengthB).toBe(22);
  });

  it('lists remembered devices while away, edits and forgets them without a lease', async () => {
    const { fake, registry } = setup();
    fake.pick('opossum', bleDevice('47L127000', 'addr-o'));
    const { id, stableKey } = await registry.connect();
    await registry.disconnect(id);
    await grantDeviceLease(null);

    expect(registry.listDeviceLimits()).toEqual([
      expect.objectContaining({ stableKey, kind: 'opossum', id: null, connected: false }),
    ]);
    const entry = await registry.setOwnLimits(stableKey, { a: 33 });
    expect(entry).toMatchObject({ ownLimits: { a: 33, b: 200 }, effectiveLimits: { a: 33 } });

    registry.forgetDeviceLimits(stableKey);
    expect(registry.listDeviceLimits()).toEqual([]);
    await expect(registry.setOwnLimits(stableKey, { a: 1 })).rejects.toMatchObject({
      code: 'unknown-device',
    });
  });

  it('edits the cap of an attached device without a lease, while output stays fenced', async () => {
    const { fake, registry, control } = setup();
    fake.pick('coyote', bleDevice('47L121000', 'addr-1'));
    const { id } = await registry.connect();
    await grantDeviceLease(null);

    await expect(registry.setOwnLimits(id, { a: 9 })).resolves.toMatchObject({
      effectiveLimits: { a: 9 },
    });
    await expect(control.execute(id, start(5))).rejects.toMatchObject({
      code: 'lease-not-held',
    });
  });

  it('keeps raw addresses out of keys and names, and falls back to the name', async () => {
    const mac = 'C1:23:45:67:89:AB';
    const key = deriveDgLabStableKey('coyote', bleDevice('47L121000', mac));
    expect(key).toMatch(/^coyote:id:[0-9a-z]+$/);
    expect(key).not.toContain('C1');
    expect(key.toLowerCase()).not.toContain('89:ab');
    expect(deriveDgLabStableKey('coyote', bleDevice('47L121000'))).toMatch(/^coyote:name:/);
    expect(deriveDgLabStableKey('coyote', bleDevice('47L121000', 'a'))).not.toBe(
      deriveDgLabStableKey('opossum', bleDevice('47L121000', 'a')),
    );

    const { fake, registry } = setup();
    fake.pick('coyote', bleDevice(mac, mac));
    await registry.connect();
    const [entry] = registry.listDeviceLimits();
    expect(JSON.stringify(entry)).not.toContain(mac);
    expect(JSON.stringify(loadDeviceLimits())).not.toContain(mac);
    expect(entry!.name).toBe('郊狼');
  });

  it('ignores corrupted storage: the global caps still apply and nothing throws', async () => {
    localStorage.setItem('0xnullai.device-limits', '{坏的');
    const { fake, registry, control } = setup();
    fake.pick('coyote', bleDevice('47L121000', 'addr-1'));
    const { id, stableKey } = await registry.connect();

    await control.execute(id, start(200));
    expect(fake.coyotes[0]!.state.strengthA).toBe(50);
    expect(registry.listDeviceLimits()).toHaveLength(1);

    // A corrupted record for this device is dropped, not half-trusted.
    localStorage.setItem(
      '0xnullai.device-limits',
      JSON.stringify({ [stableKey]: { kind: 'coyote', a: 'x', b: 10 } }),
    );
    await control.execute(id, start(200, 'B'));
    expect(fake.coyotes[0]!.state.strengthB).toBe(50);
  });

  it('ignores a record of the other kind under the same key', async () => {
    const { fake, registry, control } = setup();
    const device = bleDevice('47L121000', 'addr-1');
    updateDeviceLimit(deriveDgLabStableKey('coyote', device), { kind: 'opossum', a: 1, b: 1 });
    fake.pick('coyote', device);
    const { id } = await registry.connect();
    await control.execute(id, start(30));
    expect(fake.coyotes[0]!.state.strengthA).toBe(30);
  });
});

describe('per-device limits: stops and display', () => {
  it('emergency stop still reaches every Coyote and Opossum', async () => {
    const { fake, registry, control } = setup();
    fake.pick('coyote', bleDevice('47L121000', 'addr-1'));
    fake.pick('coyote', bleDevice('47L121000', 'addr-2'));
    fake.pick('opossum', bleDevice('47L127000', 'addr-o'));
    const ids = [];
    for (let index = 0; index < 3; index += 1) ids.push((await registry.connect()).id);
    await registry.setOwnLimits(ids[0]!, { a: 0, b: 0 });
    await registry.setOwnLimits(ids[2]!, { a: 0, b: 0 });
    await control.execute(ids[1]!, start(30));
    const before = [...fake.coyotes, ...fake.opossums].map((client) => client.stops);

    await control.emergencyStop();

    expect([...fake.coyotes, ...fake.opossums].map((client) => client.stops)).toEqual(
      before.map((count) => count + 1),
    );
    expect(fake.coyotes[1]!.state.strengthA).toBe(0);
  });

  it('shows the effective cap in snapshots and the shell device bar', async () => {
    const { fake, registry } = setup();
    fake.pick('coyote', bleDevice('47L121000', 'addr-1'));
    fake.pick('opossum', bleDevice('47L127000', 'addr-o'));
    const coyote = await registry.connect();
    const opossum = await registry.connect();
    await registry.setOwnLimits(coyote.id, { b: 12 });
    await registry.setOwnLimits(opossum.id, { a: 7 });

    const snapshots = registry.list();
    expect(snapshots[0]).toMatchObject({
      limits: { a: 50, b: 12 },
      state: { limitA: 50, limitB: 12 },
    });
    expect(snapshots[1]).toMatchObject({ limits: { a: 7, b: 50 } });
    const bar = allConnectedDevices().find((group) => group.sessionId === DGLAB_SAFETY_SESSION_ID);
    expect(bar!.devices.map((device) => device.channels?.map((channel) => channel.max))).toEqual([
      [50, 12],
      [7, 50],
    ]);
  });
});
