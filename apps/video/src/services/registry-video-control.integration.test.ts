import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createEmptyDeviceState,
  type DeviceCommand,
  type DeviceCommandResult,
  type DeviceState,
} from '@dg-agent/core';
import { grantDeviceLease, hasDeviceLease } from '@dg-kit/safety';
import { DEFAULT_DEVICE_SAFETY } from '@0xnullai/settings';
import {
  DgLabConnectionRegistry,
  type DgLabCoyoteClient,
  type DgLabTransport,
} from '@0xnullai/device-runtime';
import type { VideoControlSafetyLimits } from '@dg-agent/runtime';
import {
  bindRegistryVideoControl,
  createRegistryVideoControl,
  type RegistryVideoControl,
} from './registry-video-control.js';

const limits: VideoControlSafetyLimits = {
  maxStrengthA: 100,
  maxStrengthB: 100,
  maxColdStartStrength: 20,
  maxAdjustStep: 10,
  maxBurstDurationMs: 2_000,
  maxBurstStrengthAbsolute: 50,
  maxBurstStrengthRelative: 10,
  maxIntensityA: 100,
  maxIntensityB: 100,
  maxColdStartIntensity: 20,
  maxOpossumAdjustStep: 10,
  maxToolIterations: 3,
  maxToolCallsPerTurn: 5,
  maxAdjustStrengthCallsPerTurn: 3,
  maxBurstCallsPerTurn: 1,
  maxVibrateAdjustCallsPerTurn: 3,
  maxVibrateBurstCallsPerTurn: 1,
  burstRequiresActiveChannel: true,
};

type PickedDevice = Awaited<ReturnType<DgLabTransport['requestDevice']>>;

const grantInput = {
  intensityCap: 30,
  allowEnhanced: false,
  allowBurst: false,
  durationMs: 60_000,
  cadenceMs: 5_000,
  captureIntervalMs: 1_000,
};

/** Coyote link fake: the registry attaches it; it records every write that reaches "BLE". */
class FakeCoyote implements DgLabCoyoteClient {
  state: DeviceState = createEmptyDeviceState();
  readonly writes: DeviceCommand[] = [];
  private readonly listeners = new Set<(state: DeviceState) => void>();

  async connect(): Promise<void> {
    throw new Error('the registry attaches picked devices');
  }
  async connectDevice(): Promise<void> {
    this.set({ ...this.state, connected: true, deviceName: '47L121000' });
  }
  async disconnect(): Promise<void> {
    this.set({ ...this.state, connected: false });
  }
  async getState(): Promise<DeviceState> {
    return { ...this.state };
  }
  async execute(command: DeviceCommand): Promise<DeviceCommandResult> {
    this.writes.push(command);
    if (command.type === 'start') {
      this.set({
        ...this.state,
        [command.channel === 'A' ? 'strengthA' : 'strengthB']: command.strength,
        [command.channel === 'A' ? 'waveActiveA' : 'waveActiveB']: true,
      });
    }
    return { state: { ...this.state } };
  }
  async emergencyStop(): Promise<void> {
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

let registry: DgLabConnectionRegistry | null = null;
let control: RegistryVideoControl | null = null;

afterEach(async () => {
  await control?.service.dispose();
  control = null;
  await registry?.dispose();
  registry = null;
  await grantDeviceLease(null);
});

function harness() {
  const clients: FakeCoyote[] = [];
  let address = 0;
  const transport: DgLabTransport = {
    requestDevice: async () => {
      address += 1;
      const device = Object.assign(new EventTarget(), {
        name: '47L121000',
        id: `addr-${address}`,
        gatt: { connected: true, connect: async () => ({}), disconnect: () => undefined },
      }) as PickedDevice['device'];
      return { kind: 'coyote', device, server: {} as PickedDevice['server'] };
    },
    createCoyoteClient: () => {
      const client = new FakeCoyote();
      clients.push(client);
      return client;
    },
    createOpossumClient: () => {
      throw new Error('not used');
    },
    createSensorClient: () => {
      throw new Error('not used');
    },
  };
  registry = new DgLabConnectionRegistry({ transport, limits: () => DEFAULT_DEVICE_SAFETY });
  control = createRegistryVideoControl(registry, {
    getLlm: () => null,
    getSafetyLimits: () => limits,
  });
  const events = { onTopologyChange: vi.fn(), onRevoked: vi.fn() };
  const unbind = bindRegistryVideoControl(control, events);
  return { registry, control, clients, events, unbind };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe('Video on the shared DG-Lab registry', () => {
  it('targets a Coyote that another module connected, once Video holds the lease', async () => {
    const { registry, control, clients } = harness();
    await registry.forModule('agent').connect();
    await settle();

    const [target] = control.service.getTargets();
    expect(target).toMatchObject({ kind: 'coyote' });

    // Without the lease the holder-side runtime refuses before any write.
    await expect(
      control.service.executeAiAction(
        target!,
        { id: 'denied', action: 'start', channel: 'A', value: 10 },
        grantInput,
      ),
    ).rejects.toThrow();
    expect(clients[0]!.writes.filter((command) => command.type === 'start')).toHaveLength(0);

    await grantDeviceLease('video');
    await control.service.executeAiAction(
      target!,
      { id: 'start', action: 'start', channel: 'A', value: 10 },
      grantInput,
    );
    expect(clients[0]!.writes.some((command) => command.type === 'start')).toBe(true);
    expect(clients[0]!.state.strengthA).toBe(10);
  });

  it('revokes the grant when another module changes the target set', async () => {
    const { registry, control, events } = harness();
    const agent = registry.forModule('agent');
    await agent.connect();
    await settle();
    await grantDeviceLease('video');
    const [target] = control.service.getTargets();
    await control.service.executeAiAction(
      target!,
      { id: 'start', action: 'start', channel: 'A', value: 10 },
      grantInput,
    );
    expect(control.service.getGrant()).toMatchObject({ revoked: false });
    events.onTopologyChange.mockClear();

    await agent.connect();
    await settle();

    expect(control.service.getGrant()).toMatchObject({ revoked: true });
    expect(events.onTopologyChange).toHaveBeenCalledTimes(1);
    expect(control.service.getTargets()).toHaveLength(2);
  });

  it('does not stop other modules on a topology change while Video holds no grant', async () => {
    const { registry, control, clients, events } = harness();
    const agent = registry.forModule('agent');
    await agent.connect();
    await grantDeviceLease('agent');
    const [device] = agent.list();
    await agent.execute(device!.id, {
      type: 'start',
      channel: 'A',
      strength: 15,
      waveform: { id: 'w', name: 'w', frames: [[10, 50]] },
      loop: true,
    });
    events.onTopologyChange.mockClear();

    await agent.connect();
    await settle();

    expect(events.onTopologyChange).toHaveBeenCalledTimes(1);
    expect(control.service.getGrant()).toBeNull();
    expect(clients[0]!.state.strengthA).toBe(15);
  });

  it('stops output, tells Video, and rejects its commands after the lease moves', async () => {
    const { registry, control, clients, events } = harness();
    await registry.forModule('agent').connect();
    await settle();
    await grantDeviceLease('video');
    const [target] = control.service.getTargets();
    await control.service.executeAiAction(
      target!,
      { id: 'start', action: 'start', channel: 'A', value: 10 },
      grantInput,
    );
    expect(clients[0]!.state.strengthA).toBe(10);

    await grantDeviceLease('agent');
    await settle();

    expect(hasDeviceLease('video')).toBe(false);
    expect(events.onRevoked).toHaveBeenCalledTimes(1);
    expect(clients[0]!.state.strengthA).toBe(0);
    const startsBefore = clients[0]!.writes.filter((command) => command.type === 'start').length;

    await expect(
      control.service.executeAiAction(
        target!,
        { id: 'after-move', action: 'start', channel: 'A', value: 10 },
        grantInput,
      ),
    ).rejects.toThrow();
    // A write that reaches the registry handle directly is fenced too.
    await expect(
      control.handle.execute(registry.list()[0]!.id, {
        type: 'start',
        channel: 'A',
        strength: 10,
        waveform: { id: 'w', name: 'w', frames: [[10, 50]] },
        loop: true,
      }),
    ).rejects.toMatchObject({ code: expect.any(String) });
    expect(clients[0]!.writes.filter((command) => command.type === 'start')).toHaveLength(
      startsBefore,
    );
    expect(clients[0]!.state.strengthA).toBe(0);
  });
});
