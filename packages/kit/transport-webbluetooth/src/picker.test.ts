import { describe, expect, it, vi } from 'vitest';
import { requestDgLabDevice } from './picker.js';

class FakeGatt {
  connected = false;
  connect = vi.fn<() => Promise<this>>(async () => {
    this.connected = true;
    return this;
  });
  disconnect = vi.fn(() => {
    this.connected = false;
  });
}

class FakeBluetoothDevice extends EventTarget {
  gatt: FakeGatt = new FakeGatt();
  constructor(public name: string) {
    super();
  }
}

function setupNav(deviceName: string): {
  nav: { bluetooth: { requestDevice: ReturnType<typeof vi.fn> } };
  device: FakeBluetoothDevice;
} {
  const device = new FakeBluetoothDevice(deviceName);
  const requestDevice = vi.fn(async () => device);
  return { nav: { bluetooth: { requestDevice } }, device };
}

describe('requestDgLabDevice', () => {
  it.each([
    ['47L121000', 'coyote'],
    ['47L120000', 'paw-prints'],
    ['47L124000', 'civet-edging'],
    ['47L127000', 'opossum'],
  ])('detects %s as %s by name prefix and connects its GATT server', async (name, kind) => {
    const { nav, device } = setupNav(name);

    const result = await requestDgLabDevice({ navigatorRef: nav as any });

    expect(result.kind).toBe(kind);
    expect(result.device).toBe(device);
    expect(device.gatt.connect).toHaveBeenCalledTimes(1);
    expect(device.gatt.connected).toBe(true);
  });

  it('rejects and disconnects an unrecognized device name', async () => {
    const { nav, device } = setupNav('some-other-ble-thing');
    await expect(requestDgLabDevice({ navigatorRef: nav as any })).rejects.toThrow('未识别的设备');
    // Never got far enough to connect GATT at all — nothing to disconnect.
    expect(device.gatt.connect).not.toHaveBeenCalled();
  });

  it('throws when the picked device exposes no GATT', async () => {
    const device = new FakeBluetoothDevice('47L121000');

    (device as any).gatt = undefined;
    const requestDevice = vi.fn(async () => device);
    const result = requestDgLabDevice({
      navigatorRef: { bluetooth: { requestDevice } } as any,
    });
    await expect(result).rejects.toThrow('不支持 GATT');
  });

  it('disconnects and rethrows when gatt.connect() fails', async () => {
    const { nav, device } = setupNav('47L127000');
    device.gatt.connect = vi.fn<() => Promise<FakeGatt>>(async () => {
      device.gatt.connected = true;
      throw new Error('connect refused');
    });

    await expect(requestDgLabDevice({ navigatorRef: nav as any })).rejects.toThrow(
      'connect refused',
    );
    expect(device.gatt.disconnect).toHaveBeenCalledTimes(1);
  });
});
