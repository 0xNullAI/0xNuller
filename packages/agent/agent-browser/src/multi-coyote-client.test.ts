import { describe, expect, it, vi } from 'vitest';
import { createEmptyDeviceState, type DeviceState } from '@dg-agent/core';
import type { BluetoothDeviceLike, BluetoothRemoteGATTServerLike } from '@dg-kit/protocol';
import { MultiCoyoteDeviceClient } from './multi-coyote-client.js';

class FakeChildClient {
  state: DeviceState = createEmptyDeviceState();
  deviceId: string | null = null;
  listeners = new Set<(state: DeviceState) => void>();
  connect = vi.fn(async () => undefined);
  disconnect = vi.fn(async () => {
    this.state = { ...this.state, connected: false };
    this.emit();
  });
  execute = vi.fn(async () => ({ state: this.state }));
  emergencyStop = vi.fn(async () => undefined);
  getState = vi.fn(async () => this.state);
  connectDevice = vi.fn(async (device: BluetoothDeviceLike) => {
    this.deviceId = device.id ?? null;
    this.state = {
      ...createEmptyDeviceState(),
      connected: true,
      deviceName: device.name ?? undefined,
    };
    this.emit();
  });
  onStateChanged(listener: (state: DeviceState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(): void {
    for (const listener of this.listeners) listener(this.state);
  }
}

function device(id: string, name: string): BluetoothDeviceLike {
  return Object.assign(new EventTarget(), { id, name });
}

const server = {} as BluetoothRemoteGATTServerLike;

describe('MultiCoyoteDeviceClient', () => {
  it('holds two Coyote hosts in separate clients instead of reporting 设备已连接', async () => {
    const children: FakeChildClient[] = [];
    const aggregate = new MultiCoyoteDeviceClient(() => {
      const child = new FakeChildClient();
      children.push(child);
      return child;
    });

    await aggregate.connectDevice(device('coyote-a', '47L121-A'), server);
    await aggregate.connectDevice(device('coyote-b', '47L121-B'), server);

    expect(children).toHaveLength(2);
    expect(aggregate.getConnectedCoyotes().map(({ id }) => id)).toEqual(['coyote-a', 'coyote-b']);
  });

  it('keeps separate hosts when a transport reports the same device id', async () => {
    const children: FakeChildClient[] = [];
    const aggregate = new MultiCoyoteDeviceClient(() => {
      const child = new FakeChildClient();
      children.push(child);
      return child;
    });

    await aggregate.connectDevice(device('duplicate-id', '47L121-A'), server);
    await aggregate.connectDevice(device('duplicate-id', '47L121-B'), server);

    expect(children).toHaveLength(2);
    expect(aggregate.getConnectedCoyotes().map(({ id }) => id)).toEqual([
      'duplicate-id',
      'duplicate-id#2',
    ]);
  });

  it('reuses a slot only when reconnecting the exact same Bluetooth device', async () => {
    const children: FakeChildClient[] = [];
    const aggregate = new MultiCoyoteDeviceClient(() => {
      const child = new FakeChildClient();
      children.push(child);
      return child;
    });
    const sameDevice = device('coyote-a', '47L121-A');

    await aggregate.connectDevice(sameDevice, server);
    await aggregate.connectDevice(sameDevice, server);

    expect(children).toHaveLength(1);
    expect(children[0]!.connectDevice).toHaveBeenCalledTimes(2);
  });

  it('routes ordinary AI commands to the user-selected host', async () => {
    const children: FakeChildClient[] = [];
    const aggregate = new MultiCoyoteDeviceClient(() => {
      const child = new FakeChildClient();
      children.push(child);
      return child;
    });
    await aggregate.connectDevice(device('coyote-a', '47L121-A'), server);
    await aggregate.connectDevice(device('coyote-b', '47L121-B'), server);

    aggregate.selectDeviceById('coyote-b');
    await aggregate.execute({ type: 'stop' });

    expect(aggregate.deviceId).toBe('coyote-b');
    expect(children[0]!.execute).not.toHaveBeenCalled();
    expect(children[1]!.execute).toHaveBeenCalledTimes(1);
    expect(() => aggregate.selectDeviceById('missing')).toThrow('目标郊狼未连接');
  });

  it('keeps legacy commands on the primary host and emergency-stops every host', async () => {
    const children: FakeChildClient[] = [];
    const aggregate = new MultiCoyoteDeviceClient(() => {
      const child = new FakeChildClient();
      children.push(child);
      return child;
    });
    await aggregate.connectDevice(device('coyote-a', '47L121-A'), server);
    await aggregate.connectDevice(device('coyote-b', '47L121-B'), server);

    await aggregate.execute({ type: 'stop' });
    await aggregate.emergencyStop();

    expect(children[0]!.execute).toHaveBeenCalledTimes(1);
    expect(children[1]!.execute).not.toHaveBeenCalled();
    expect(children[0]!.emergencyStop).toHaveBeenCalledTimes(1);
    expect(children[1]!.emergencyStop).toHaveBeenCalledTimes(1);
  });

  it('disconnects one host by stable id without dropping the other', async () => {
    const children: FakeChildClient[] = [];
    const aggregate = new MultiCoyoteDeviceClient(() => {
      const child = new FakeChildClient();
      children.push(child);
      return child;
    });
    await aggregate.connectDevice(device('coyote-a', '47L121-A'), server);
    await aggregate.connectDevice(device('coyote-b', '47L121-B'), server);

    await aggregate.disconnectDeviceById('coyote-a');

    expect(children[0]!.disconnect).toHaveBeenCalledTimes(1);
    expect(children[1]!.disconnect).not.toHaveBeenCalled();
    expect(aggregate.getConnectedCoyotes().map(({ id }) => id)).toEqual(['coyote-b']);
  });
});
