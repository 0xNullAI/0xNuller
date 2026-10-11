import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useEffect } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { createEmptyDeviceState, type DeviceCommand, type DeviceState } from '@dg-kit/core';
import {
  allConnectedDevices,
  grantDeviceLease,
  safetySessionById,
  type DeviceSummary,
} from '@dg-kit/safety';
import {
  DgLabConnectionRegistry,
  useDevice,
  type DgLabCoyoteClient,
  type DgLabTransport,
} from '@0xnullai/device-runtime';
import { NativeBridgeProvider, useDgLabRegistry } from '@0xnullai/native';
import { DEFAULT_DEVICE_SAFETY } from '@0xnullai/settings';
import { useSafetySession } from '@0xnullai/ui';
import { GameDeviceProvider } from '../../../playground/src/GameDeviceProvider';
import { useGameDevice, type GameDeviceValue } from '../../../playground/src/use-game-device';
import { DeviceBar } from '../DeviceBar';

type Picked = Awaited<ReturnType<DgLabTransport['requestDevice']>>;
type BluetoothDeviceLike = Picked['device'];

/**
 * Control, Playground and Chat share the app's one DG-Lab registry instead of each opening its
 * own BLE connection. Playground is the real provider; Control and Chat are their `useDevice`
 * views with the same safety-session shape the apps register (connect, stop, no device list).
 * The full apps need module aliases and a room transport that this project does not provide.
 */

class FakeCoyote implements DgLabCoyoteClient {
  state: DeviceState = createEmptyDeviceState();
  readonly writes: DeviceCommand[] = [];
  stops = 0;
  disconnects = 0;
  private readonly listeners = new Set<(state: DeviceState) => void>();
  async connect(): Promise<void> {
    throw new Error('the registry attaches picked devices; it never opens a second chooser');
  }
  async connectDevice(device: BluetoothDeviceLike): Promise<void> {
    this.set({ ...this.state, connected: true, deviceName: device.name, battery: 80 });
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
      this.set({ ...this.state, waveActiveA: true, currentWaveA: command.waveform.id });
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

const server = {} as Picked['server'];
const picked = Object.assign(new EventTarget(), {
  name: '47L121000',
  id: 'addr-1',
  gatt: { connected: true, connect: async () => server, disconnect: () => undefined },
}) as BluetoothDeviceLike;

let clients: FakeCoyote[] = [];
let registry: DgLabConnectionRegistry;

const seen: {
  control: ReturnType<typeof useDevice> | null;
  chat: ReturnType<typeof useDevice> | null;
  game: GameDeviceValue | null;
} = { control: null, chat: null, game: null };

function ModuleProbe({ id }: { id: 'control' | 'chat' }) {
  const device = useDevice({ moduleId: id, registry: useDgLabRegistry() });
  useEffect(() => {
    seen[id] = device;
  });
  useSafetySession({
    id,
    label: id,
    isActive: () => device.connected,
    stop: device.stopAll,
    connect: device.connectDevice,
    onRevoke: device.stopAll,
  });
  return null;
}

function GameProbe() {
  const game = useGameDevice();
  useEffect(() => {
    seen.game = game;
  });
  return null;
}

function renderApp() {
  return render(
    <NativeBridgeProvider bridge={{ dglab: registry }} native={false}>
      <ModuleProbe id="control" />
      <GameDeviceProvider>
        <GameProbe />
      </GameDeviceProvider>
      <ModuleProbe id="chat" />
      <DeviceBar activeSessionId="control" showConnect />
    </NativeBridgeProvider>,
  );
}

function listedDevices(): DeviceSummary[] {
  return allConnectedDevices().flatMap((group) => group.devices);
}

beforeEach(async () => {
  clients = [];
  const transport: DgLabTransport = {
    requestDevice: async () => ({ kind: 'coyote', device: picked, server }),
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
  await grantDeviceLease('control');
});

afterEach(async () => {
  cleanup();
  await registry.dispose();
  await grantDeviceLease(null);
  seen.control = seen.chat = seen.game = null;
});

describe('shared DG-Lab connection across Control, Playground and Chat', () => {
  it('a device connected in Control is the same device, with one adapter, everywhere', async () => {
    renderApp();
    // The shell's connect entry is the active module's session.
    await act(async () => {
      await safetySessionById('control')!.connect!();
    });

    const [only] = registry.list();
    expect(clients).toHaveLength(1);
    await waitFor(() => expect(seen.chat?.coyotes.map((c) => c.id)).toEqual([only!.id]));
    expect(seen.control?.coyotes.map((c) => c.id)).toEqual([only!.id]);
    expect(seen.game?.connected).toBe(true);

    // A second pick of the same device from another module reuses the slot.
    await act(async () => {
      await seen.chat!.connectDevice();
    });
    expect(clients).toHaveLength(1);
    expect(registry.list()).toHaveLength(1);
  });

  it('lists the device exactly once in the device bar', async () => {
    const { container } = renderApp();
    await act(async () => {
      await safetySessionById('control')!.connect!();
    });

    expect(listedDevices()).toHaveLength(1);
    for (const moduleId of ['control', 'playground', 'chat']) {
      expect(safetySessionById(moduleId)?.devices?.() ?? []).toEqual([]);
    }
    // The bar polls once a second; one chip, one disconnect button.
    await waitFor(
      () =>
        expect(
          container.querySelector('#shl-device-bar')?.querySelectorAll('[aria-label^="断开"]'),
        ).toHaveLength(1),
      { timeout: 2_000 },
    );
  });

  it('stops output on a lease switch without dropping the link', async () => {
    renderApp();
    await act(async () => {
      await safetySessionById('control')!.connect!();
    });
    await act(async () => {
      await grantDeviceLease('playground');
    });
    await waitFor(() => expect(seen.game?.holdsLease).toBe(true));

    act(() => seen.game!.pulse('strong'));
    await waitFor(() => expect(clients[0]!.state.strengthA).toBeGreaterThan(0));
    const stops = clients[0]!.stops;

    await act(async () => {
      await grantDeviceLease('chat');
    });

    await waitFor(() => expect(clients[0]!.state.strengthA).toBe(0));
    expect(clients[0]!.stops).toBeGreaterThan(stops);
    expect(clients[0]!.disconnects).toBe(0);
    expect(registry.list()[0]).toMatchObject({ connected: true });
  });

  it('rejects a Chat command after the lease moves away from Chat', async () => {
    renderApp();
    await act(async () => {
      await safetySessionById('control')!.connect!();
    });
    await act(async () => {
      await grantDeviceLease('chat');
    });
    await waitFor(() => expect(seen.chat?.connected).toBe(true));

    act(() => seen.chat!.setStrength('A', 10));
    await waitFor(() => expect(clients[0]!.state.strengthA).toBe(10));

    await act(async () => {
      await grantDeviceLease('control');
    });
    await waitFor(() => expect(clients[0]!.state.strengthA).toBe(0));
    const writes = clients[0]!.writes.length;

    act(() => seen.chat!.setStrength('A', 20));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(clients[0]!.writes).toHaveLength(writes);
    expect(clients[0]!.state.strengthA).toBe(0);
  });

  it('disconnects through the registry from Control, and every module sees it go', async () => {
    renderApp();
    await act(async () => {
      await safetySessionById('control')!.connect!();
    });
    await waitFor(() => expect(seen.chat?.connected).toBe(true));

    await act(async () => {
      await seen.control!.disconnectCoyote();
    });

    expect(clients[0]!.disconnects).toBe(1);
    expect(registry.list()).toEqual([]);
    await waitFor(() => expect(seen.chat?.coyotes).toEqual([]));
    expect(seen.game?.connected).toBe(false);
  });
});
