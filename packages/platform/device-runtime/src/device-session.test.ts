import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { grantDeviceLease } from '@dg-kit/safety';
import { DEFAULT_DEVICE_SAFETY } from '@0xnullai/settings';
import { DeviceSession } from './device-session.js';
import { DgLabConnectionRegistry } from './dglab/dglab-connection-registry.js';
import type {
  DgLabCoyoteClient,
  DgLabOpossumClient,
  DgLabSensorClient,
  DgLabSensorReading,
  DgLabTransport,
} from './dglab/dglab-transport.js';

/**
 * The module view over the shared registry. The registry itself (single adapter per device,
 * lease fence, holder caps) is covered next to it; these tests cover what a module adds on top:
 * absolute-to-delta strength, module caps, stop coverage and the sensor-to-Opossum link.
 */

const server = {} as BluetoothRemoteGATTServerLike;

function pickable(name: string, id: string): BluetoothDeviceLike {
  return Object.assign(new EventTarget(), {
    name,
    id,
    gatt: { connected: true, connect: async () => server, disconnect: () => undefined },
  });
}

class Listeners<T> {
  private readonly set = new Set<(value: T) => void>();
  add(listener: (value: T) => void): () => void {
    this.set.add(listener);
    return () => this.set.delete(listener);
  }
  emit(value: T): void {
    for (const listener of [...this.set]) listener(value);
  }
}

class FakeCoyote implements DgLabCoyoteClient {
  state: DeviceState = createEmptyDeviceState();
  readonly writes: DeviceCommand[] = [];
  stops = 0;
  disconnects = 0;
  private readonly states = new Listeners<DeviceState>();
  async connect(): Promise<void> {
    throw new Error('the registry attaches picked devices only');
  }
  async connectDevice(device: BluetoothDeviceLike): Promise<void> {
    this.set({ ...this.state, connected: true, deviceName: device.name });
  }
  async disconnect(): Promise<void> {
    this.disconnects += 1;
    this.set({ ...this.state, connected: false });
  }
  async getState(): Promise<DeviceState> {
    return { ...this.state };
  }
  async execute(command: DeviceCommand) {
    this.writes.push(command);
    if (command.type === 'adjustStrength') {
      const key = command.channel === 'A' ? 'strengthA' : 'strengthB';
      this.set({ ...this.state, [key]: this.state[key] + command.delta });
    }
    if (command.type === 'changeWave') {
      this.set({
        ...this.state,
        [command.channel === 'A' ? 'waveActiveA' : 'waveActiveB']: true,
        [command.channel === 'A' ? 'currentWaveA' : 'currentWaveB']: command.waveform.id,
      });
    }
    return { state: { ...this.state } };
  }
  async emergencyStop(): Promise<void> {
    this.stops += 1;
    this.set({ ...this.state, strengthA: 0, strengthB: 0, waveActiveA: false, waveActiveB: false });
  }
  onStateChanged(listener: (state: DeviceState) => void): () => void {
    return this.states.add(listener);
  }
  private set(state: DeviceState): void {
    this.state = state;
    this.states.emit({ ...state });
  }
}

class FakeOpossum implements DgLabOpossumClient {
  state: OpossumState = createEmptyOpossumState();
  readonly writes: OpossumCommand[] = [];
  stops = 0;
  private readonly states = new Listeners<OpossumState>();
  async connect(): Promise<void> {}
  async connectDevice(device: BluetoothDeviceLike): Promise<void> {
    this.set({ ...this.state, connected: true, deviceName: device.name });
  }
  async disconnect(): Promise<void> {
    this.set({ ...this.state, connected: false });
  }
  async getState(): Promise<OpossumState> {
    return { ...this.state };
  }
  async execute(command: OpossumCommand) {
    this.writes.push(command);
    if (command.type === 'vibrateStart') {
      this.set({
        ...this.state,
        [command.channel === 'A' ? 'intensityA' : 'intensityB']: command.intensity,
      });
    }
    return { state: { ...this.state } };
  }
  async emergencyStop(): Promise<void> {
    this.stops += 1;
    this.set({ ...this.state, intensityA: 0, intensityB: 0 });
  }
  async setIndicatorColor(): Promise<void> {}
  onStateChanged(listener: (state: OpossumState) => void): () => void {
    return this.states.add(listener);
  }
  private set(state: OpossumState): void {
    this.state = state;
    this.states.emit({ ...state });
  }
}

class FakeSensor implements DgLabSensorClient {
  state: SensorState = createEmptySensorState();
  private readonly states = new Listeners<SensorState>();
  private readonly readings = new Listeners<DgLabSensorReading>();
  async connect(): Promise<void> {}
  async connectDevice(device: BluetoothDeviceLike): Promise<void> {
    this.set({ connected: true, deviceName: device.name });
  }
  async disconnect(): Promise<void> {
    this.set({ ...this.state, connected: false });
  }
  async getState(): Promise<SensorState> {
    return { ...this.state };
  }
  subscribe(listener: (reading: DgLabSensorReading) => void): () => void {
    return this.readings.add(listener);
  }
  onStateChanged(listener: (state: SensorState) => void): () => void {
    return this.states.add(listener);
  }
  emit(reading: DgLabSensorReading): void {
    this.readings.emit(reading);
  }
  private set(state: SensorState): void {
    this.state = state;
    this.states.emit({ ...state });
  }
}

function harness() {
  const picks: RequestedDevice[] = [];
  const coyotes: FakeCoyote[] = [];
  const opossums: FakeOpossum[] = [];
  const sensors: FakeSensor[] = [];
  const transport: DgLabTransport = {
    requestDevice: async () => {
      const next = picks.shift();
      if (!next) throw new Error('no pick queued');
      return next;
    },
    createCoyoteClient: () => {
      const client = new FakeCoyote();
      coyotes.push(client);
      return client;
    },
    createOpossumClient: () => {
      const client = new FakeOpossum();
      opossums.push(client);
      return client;
    },
    createSensorClient: () => {
      const client = new FakeSensor();
      sensors.push(client);
      return client;
    },
  };
  let seq = 0;
  const registry = new DgLabConnectionRegistry({
    transport,
    limits: () => DEFAULT_DEVICE_SAFETY,
    createId: (kind) => `${kind}-${++seq}`,
  });
  const pick = (kind: DeviceKind, name: string, address: string) =>
    picks.push({ kind, device: pickable(name, address), server });
  return { registry, pick, coyotes, opossums, sensors };
}

let registry: DgLabConnectionRegistry | null = null;
const stops: (() => void)[] = [];

function moduleSession(
  r: DgLabConnectionRegistry,
  moduleId = 'control',
  limits = { strengthA: 50, strengthB: 50, intensityA: 50, intensityB: 50 },
) {
  const session = new DeviceSession(r.forModule(moduleId), limits);
  stops.push(session.start());
  return session;
}

/** Let queued registry writes and their state callbacks settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

beforeEach(async () => {
  await grantDeviceLease('control');
});

afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  await registry?.dispose();
  registry = null;
  vi.useRealTimers();
  await grantDeviceLease(null);
});

describe('DeviceSession over the shared registry', () => {
  it('turns an absolute strength into one delta per write and lets the last target win', async () => {
    const h = harness();
    registry = h.registry;
    const session = moduleSession(h.registry);
    h.pick('coyote', '47L121000', 'addr-1');
    await session.connectDevice();
    const coyote = session.coyote!;

    // Two quick slider moves before the first write lands must not both start from 0.
    coyote.setStrength('A', 20);
    coyote.setStrength('A', 30);
    await vi.waitFor(() => expect(h.coyotes[0]!.state.strengthA).toBe(30));

    const deltas = h.coyotes[0]!.writes.flatMap((w) =>
      w.type === 'adjustStrength' ? [w.delta] : [],
    );
    expect(deltas.reduce((a, b) => a + b, 0)).toBe(30);
  });

  it('computes a target set right after a stop against the zeroed state', async () => {
    const h = harness();
    registry = h.registry;
    const session = moduleSession(h.registry);
    h.pick('coyote', '47L121000', 'addr-1');
    await session.connectDevice();
    const coyote = session.coyote!;
    coyote.setStrength('A', 10);
    await vi.waitFor(() => expect(h.coyotes[0]!.state.strengthA).toBe(10));

    // A game replacing its previous pulse: stop, then the same strength again.
    session.stopAllOutputs();
    coyote.setStrength('A', 10);

    await vi.waitFor(() => expect(h.coyotes[0]!.state.strengthA).toBe(10));
    expect(h.coyotes[0]!.stops).toBeGreaterThan(1);
  });

  it('clamps to the module cap and stops live output when the cap is lowered', async () => {
    const h = harness();
    registry = h.registry;
    const session = moduleSession(h.registry);
    h.pick('coyote', '47L121000', 'addr-1');
    await session.connectDevice();

    session.coyote!.setStrength('A', 80);
    await vi.waitFor(() => expect(h.coyotes[0]!.state.strengthA).toBe(50));
    const stopsBefore = h.coyotes[0]!.stops;

    session.setCoyoteLimit('A', 10);
    await settle();
    expect(h.coyotes[0]!.stops).toBe(stopsBefore + 1);
    expect(session.getCoyoteSummaries()[0]!.limitA).toBe(10);
  });

  it('applies module caps to a host that appears later', async () => {
    const h = harness();
    registry = h.registry;
    const session = moduleSession(h.registry);
    session.setCoyoteLimit('A', 30);
    h.pick('coyote', '47L121000', 'addr-1');
    await session.connectDevice();

    session.coyote!.setStrength('A', 45);
    await vi.waitFor(() => expect(h.coyotes[0]!.state.strengthA).toBe(30));
  });

  it('stopAllOutputs zeroes every Coyote and Opossum, whichever module attached it', async () => {
    const h = harness();
    registry = h.registry;
    const control = moduleSession(h.registry, 'control');
    const chat = moduleSession(h.registry, 'chat');
    h.pick('coyote', '47L121000', 'addr-1');
    h.pick('coyote', '47L121001', 'addr-2');
    h.pick('opossum', '47L130000', 'addr-3');
    await control.connectDevice();
    await control.connectDevice();
    await control.connectDevice();
    const before = [...h.coyotes.map((c) => c.stops), h.opossums[0]!.stops];

    // Chat does not hold the lease; stop is never lease-gated.
    chat.stopAllOutputs();
    await settle();

    expect(h.coyotes.map((c) => c.stops)).toEqual(before.slice(0, 2).map((n) => n + 1));
    expect(h.opossums[0]!.stops).toBe(before[2]! + 1);
  });

  it('a module without the lease cannot raise output', async () => {
    const h = harness();
    registry = h.registry;
    const control = moduleSession(h.registry, 'control');
    const chat = moduleSession(h.registry, 'chat');
    h.pick('coyote', '47L121000', 'addr-1');
    await control.connectDevice();

    expect(chat.coyote?.id).toBe(control.coyote?.id);
    chat.coyote!.setStrength('A', 20);
    chat.setOpossumIntensity('A', 20, 50);
    await settle();

    expect(h.coyotes[0]!.writes.filter((w) => w.type === 'adjustStrength')).toEqual([]);
  });

  it('disconnectCoyote goes through the registry, which stops before dropping the link', async () => {
    const h = harness();
    registry = h.registry;
    const session = moduleSession(h.registry);
    h.pick('coyote', '47L121000', 'addr-1');
    h.pick('coyote', '47L121001', 'addr-2');
    await session.connectDevice();
    await session.connectDevice();
    const [first, second] = session.getCoyoteSummaries();

    await session.disconnectCoyote(first!.id);

    expect(h.coyotes[0]!.disconnects).toBe(1);
    expect(h.coyotes[0]!.stops).toBeGreaterThan(1);
    expect(h.coyotes[1]!.disconnects).toBe(0);
    expect(h.registry.list().map((d) => d.id)).toEqual([second!.id]);
    expect(session.coyote?.id).toBe(second!.id);
    expect(session.coyoteById(first!.id)).toBe(null);
  });

  it('surfaces sensor readings and stops a held pressure link when the sensor goes away', async () => {
    const h = harness();
    registry = h.registry;
    const session = moduleSession(h.registry);
    h.pick('civet-edging', '47L120100', 'addr-s');
    h.pick('opossum', '47L130000', 'addr-o');
    await session.connectDevice();
    await session.connectDevice();
    session.setDeviceLinkRule({
      ...session.getDeviceLinkRule(),
      enabled: true,
      source: 'civet-pressure',
      channel: 'A',
      intensity: 40,
      thresholdKPa: 2,
      releaseKPa: 1,
    });

    h.sensors[0]!.emit({ type: 'pressure', kPa: 3 });
    await vi.waitFor(() => expect(h.opossums[0]!.state.intensityA).toBe(40));
    expect(session.getSensorSummary()?.lastValue).toBe(3);
    const stopsBefore = h.opossums[0]!.stops;

    // No release reading will ever arrive from a sensor that is gone.
    await session.disconnectSensor();
    await settle();

    expect(h.opossums[0]!.stops).toBe(stopsBefore + 1);
    expect(h.opossums[0]!.state.intensityA).toBe(0);
    expect(session.getSensorSummary()).toBe(null);
  });

  it('ends a button-link pulse after 500 ms', async () => {
    vi.useFakeTimers();
    const h = harness();
    registry = h.registry;
    const session = moduleSession(h.registry);
    h.pick('paw-prints', '47L120000', 'addr-s');
    h.pick('opossum', '47L130000', 'addr-o');
    await session.connectDevice();
    await session.connectDevice();
    session.setDeviceLinkRule({
      ...session.getDeviceLinkRule(),
      enabled: true,
      source: 'paw-button',
      channel: 'A',
      intensity: 30,
    });

    h.sensors[0]!.emit({ type: 'trigger', eventId: 1, parameterValue: 0 });
    await settle();
    expect(h.opossums[0]!.state.intensityA).toBe(30);
    const stopsBefore = h.opossums[0]!.stops;

    await vi.advanceTimersByTimeAsync(500);
    expect(h.opossums[0]!.stops).toBe(stopsBefore + 1);
  });

  it('lowering the Opossum cap stops it and clamps later commands', async () => {
    const h = harness();
    registry = h.registry;
    const session = moduleSession(h.registry);
    h.pick('opossum', '47L130000', 'addr-o');
    await session.connectDevice();
    session.setOpossumIntensity('A', 45, 200);
    await vi.waitFor(() => expect(h.opossums[0]!.state.intensityA).toBe(45));
    const stopsBefore = h.opossums[0]!.stops;

    session.setOpossumLimits(20, 20);
    await settle();
    expect(h.opossums[0]!.stops).toBe(stopsBefore + 1);

    session.setOpossumIntensity('A', 45, 200);
    await vi.waitFor(() => expect(h.opossums[0]!.state.intensityA).toBe(20));
  });
});
