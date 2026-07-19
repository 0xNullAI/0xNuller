import { describe, expect, it, vi } from 'vitest';
import {
  connectTauriAuxDevice,
  disconnectTauriAuxDevice,
  type ConnectableAdapter,
} from './aux-connect.js';
import { __setPluginBlecForTests, type BleDeviceInfo } from './plugin-blec.js';
import { makeApi, makeDevice } from './test-utils.js';

class FakeAdapter implements ConnectableAdapter {
  connectedCount = 0;
  disconnectedCount = 0;
  onConnectedImpl: ConnectableAdapter['onConnected'] = async () => {
    this.connectedCount += 1;
  };

  async onConnected(context: Parameters<ConnectableAdapter['onConnected']>[0]): Promise<void> {
    await this.onConnectedImpl(context);
  }

  async onDisconnected(): Promise<void> {
    this.disconnectedCount += 1;
  }
}

function makeAdapter(
  overrides: { onConnected?: ConnectableAdapter['onConnected'] } = {},
): FakeAdapter {
  const adapter = new FakeAdapter();
  if (overrides.onConnected) {
    adapter.onConnectedImpl = overrides.onConnected;
  }
  return adapter;
}

function scanHandlerWith(devices: BleDeviceInfo[]) {
  return vi.fn().mockImplementation(async (handler: (devices: BleDeviceInfo[]) => void) => {
    handler(devices);
  });
}

describe('connectTauriAuxDevice', () => {
  it('scans, connects, and hands (device, server) to adapter.onConnected()', async () => {
    const api = makeApi({
      startScan: scanHandlerWith([makeDevice({ address: 'OPO-1', name: '47L1270000XX' })]),
    });
    __setPluginBlecForTests(api);

    const adapter = makeAdapter();
    const device = await connectTauriAuxDevice(
      {
        selectDevice: async (c) => c.initial[0]?.address ?? null,
        scanDurationMs: 50,
        gattReadyInitialDelayMs: 0,
      },
      adapter,
      null,
      vi.fn(),
    );

    expect(device.id).toBe('OPO-1');
    expect(adapter.connectedCount).toBe(1);
    expect(api.connect).toHaveBeenCalledWith('OPO-1', expect.any(Function));
  });

  it('throws when the user cancels the picker, without ever calling api.connect', async () => {
    const api = makeApi({
      startScan: scanHandlerWith([makeDevice({ address: 'OPO-1' })]),
    });
    __setPluginBlecForTests(api);

    await expect(
      connectTauriAuxDevice(
        { selectDevice: async () => null, scanDurationMs: 50 },
        makeAdapter(),
        null,
        vi.fn(),
      ),
    ).rejects.toThrow(/取消/);
    expect(api.connect).not.toHaveBeenCalled();
  });

  it('on onConnected() failure, tears the new device down and leaves the previous device untouched', async () => {
    const api = makeApi({
      startScan: scanHandlerWith([makeDevice({ address: 'OPO-2', name: '47L1270000XX' })]),
    });
    __setPluginBlecForTests(api);

    const previousAdapter = makeAdapter();
    const previousDevice = await connectTauriAuxDevice(
      {
        selectDevice: async () => 'OPO-1',
        scanDurationMs: 50,
        gattReadyInitialDelayMs: 0,
      },
      previousAdapter,
      null,
      vi.fn(),
    );
    // Re-point the stub's scan for the second (failing) connect attempt.
    (api.startScan as ReturnType<typeof vi.fn>).mockImplementation(
      scanHandlerWith([makeDevice({ address: 'OPO-2', name: '47L1270000XX' })]),
    );

    const failingAdapter = makeAdapter({
      onConnected: async () => {
        throw new Error('handshake failed');
      },
    });

    await expect(
      connectTauriAuxDevice(
        { selectDevice: async () => 'OPO-2', scanDurationMs: 50, gattReadyInitialDelayMs: 0 },
        failingAdapter,
        previousDevice,
        vi.fn(),
      ),
    ).rejects.toThrow(/handshake failed/);

    // The previous device's connection was never touched by the failed swap.
    expect(previousDevice.gatt!.connected).toBe(true);
    expect(previousAdapter.disconnectedCount).toBe(0);
  });

  it('replaces the previous device only after the new one connects successfully', async () => {
    const api = makeApi({
      startScan: scanHandlerWith([makeDevice({ address: 'OPO-1', name: '47L1270000XX' })]),
    });
    __setPluginBlecForTests(api);

    const adapter = makeAdapter();
    const onGattDisconnected = vi.fn();
    const firstDevice = await connectTauriAuxDevice(
      { selectDevice: async () => 'OPO-1', scanDurationMs: 50, gattReadyInitialDelayMs: 0 },
      adapter,
      null,
      onGattDisconnected,
    );

    (api.startScan as ReturnType<typeof vi.fn>).mockImplementation(
      scanHandlerWith([makeDevice({ address: 'OPO-2', name: '47L1270000XX' })]),
    );

    const secondDevice = await connectTauriAuxDevice(
      { selectDevice: async () => 'OPO-2', scanDurationMs: 50, gattReadyInitialDelayMs: 0 },
      adapter,
      firstDevice,
      onGattDisconnected,
    );

    expect(secondDevice.id).toBe('OPO-2');
    // The first device was disconnected as part of the swap.
    expect(firstDevice.gatt!.connected).toBe(false);
    expect(api.disconnect).toHaveBeenCalledWith('OPO-1');
  });
});

describe('disconnectTauriAuxDevice', () => {
  it('disconnects the device and calls adapter.onDisconnected(), without touching other addresses', async () => {
    const api = makeApi({
      startScan: scanHandlerWith([makeDevice({ address: 'OPO-1', name: '47L1270000XX' })]),
    });
    __setPluginBlecForTests(api);

    const adapter = makeAdapter();
    const device = await connectTauriAuxDevice(
      { selectDevice: async () => 'OPO-1', scanDurationMs: 50, gattReadyInitialDelayMs: 0 },
      adapter,
      null,
      vi.fn(),
    );

    await disconnectTauriAuxDevice(device, adapter, vi.fn());

    expect(api.disconnect).toHaveBeenCalledWith('OPO-1');
    expect(adapter.disconnectedCount).toBe(1);
  });

  it('is a no-op on the plugin side (still calls onDisconnected) when device is null', async () => {
    const adapter = makeAdapter();
    await disconnectTauriAuxDevice(null, adapter, vi.fn());
    expect(adapter.disconnectedCount).toBe(1);
  });
});
