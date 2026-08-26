import { MultiCoyoteDeviceClient } from '@dg-agent/agent-browser';
import { createEmptyDeviceState, type DeviceState } from '@dg-kit/core';
import { createEmptyOpossumState } from '@dg-kit/protocol';
import { describe, expect, it, vi } from 'vitest';
import { DeviceSession, type DeviceSessionTransport } from './device-session.js';

class FakeCoyoteClient {
  state: DeviceState = createEmptyDeviceState();
  private readonly listeners = new Set<(state: DeviceState) => void>();
  connect = vi.fn();
  disconnect = vi.fn(async () => {
    this.state = { ...this.state, connected: false };
    this.emit();
  });
  getState = vi.fn(async () => this.state);
  execute = vi.fn(async () => ({ state: this.state, notes: [] }));
  emergencyStop = vi.fn(async () => undefined);
  connectDevice = vi.fn(async (device: { name?: string }) => {
    this.state = { ...createEmptyDeviceState(), connected: true, deviceName: device.name };
    this.emit();
  });
  onStateChanged(listener: (state: DeviceState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit() {
    for (const listener of this.listeners) listener(this.state);
  }
}

function transportHarness() {
  const children: FakeCoyoteClient[] = [];
  let targetSequence = 0;
  const coyote = new MultiCoyoteDeviceClient(
    () => {
      const child = new FakeCoyoteClient();
      children.push(child);
      return child;
    },
    () => `coyote/opaque-${++targetSequence}`,
  );
  const pickedDevices = [1, 2].map((number) =>
    Object.assign(new EventTarget(), {
      id: 'same-native-id',
      name: 'Same advertised name',
      marker: number,
    }),
  );
  let pickIndex = 0;
  const opossumState = createEmptyOpossumState();
  const transport = {
    coyote,
    opossum: {
      connect: vi.fn(),
      connectDevice: vi.fn(),
      disconnect: vi.fn(),
      getState: vi.fn(async () => opossumState),
      execute: vi.fn(),
      emergencyStop: vi.fn(),
      setIndicatorColor: vi.fn(),
      onStateChanged: vi.fn(() => vi.fn()),
    },
    requestDevice: vi.fn(async () => ({
      kind: 'coyote',
      device: pickedDevices[pickIndex++]!,
      server: { connected: true, getPrimaryService: vi.fn() },
    })),
  } as unknown as DeviceSessionTransport;
  return { transport, children };
}

describe('Voice multi-Coyote identity and routing', () => {
  it('keeps two same-kind same-name devices as separate opaque targets', async () => {
    const { transport, children } = transportHarness();
    const session = new DeviceSession(transport);

    await session.connectDevice();
    await session.connectDevice();
    const targets = await session.listCoyoteTargets();

    expect(children).toHaveLength(2);
    expect(targets.map(({ targetId }) => targetId)).toEqual(['coyote/opaque-1', 'coyote/opaque-2']);
    expect(targets[0]?.state.deviceName).toBe(targets[1]?.state.deviceName);
    expect(targets.map(({ targetId }) => targetId).join()).not.toContain('same-native-id');
    expect(targets.map(({ targetId }) => targetId).join()).not.toContain('Same advertised name');
  });

  it('disconnects one exact target without dropping the other', async () => {
    const { transport, children } = transportHarness();
    const session = new DeviceSession(transport);
    await session.connectDevice();
    await session.connectDevice();
    const [first, second] = await session.listCoyoteTargets();

    await session.disconnectCoyote(first!.targetId);

    expect(children[0]!.disconnect).toHaveBeenCalledTimes(1);
    expect(children[1]!.disconnect).not.toHaveBeenCalled();
    expect((await session.listCoyoteTargets()).map(({ targetId }) => targetId)).toEqual([
      second!.targetId,
    ]);
  });

  it('executes on one exact same-name target without selecting or fanning out', async () => {
    const { transport, children } = transportHarness();
    const session = new DeviceSession(transport);
    await session.connectDevice();
    await session.connectDevice();
    const [, second] = await session.listCoyoteTargets();

    await session.coyoteTargetRouter.executeTarget(second!.targetId, {
      type: 'adjustStrength',
      channel: 'A',
      delta: 1,
    });

    expect(children[0]!.execute).not.toHaveBeenCalled();
    expect(children[1]!.execute).toHaveBeenCalledTimes(1);
  });
});
