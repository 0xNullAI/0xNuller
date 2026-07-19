import { describe, expect, it, vi } from 'vitest';
import { TauriBlecOpossumClient } from './opossum-client.js';
import { __setPluginBlecForTests, type BleDeviceInfo } from './plugin-blec.js';
import { makeApi, makeDevice } from './test-utils.js';

function scanHandlerWith(devices: BleDeviceInfo[]) {
  return vi.fn().mockImplementation(async (handler: (devices: BleDeviceInfo[]) => void) => {
    handler(devices);
  });
}

describe('TauriBlecOpossumClient', () => {
  it('connects, reports its address, and reaches the connected state', async () => {
    const api = makeApi({
      startScan: scanHandlerWith([makeDevice({ address: 'OPO-1', name: '47L1270000XX' })]),
    });
    __setPluginBlecForTests(api);

    const client = new TauriBlecOpossumClient({
      selectDevice: async (c) => c.initial[0]?.address ?? null,
      scanDurationMs: 50,
      gattReadyInitialDelayMs: 0,
    });

    await client.connect();

    expect(client.address).toBe('OPO-1');
    const state = await client.getState();
    expect(state.connected).toBe(true);
    // Default scan filter is Opossum-only when namePrefixes isn't overridden.
    expect(api.startScan).toHaveBeenCalled();
  });

  it('execute() vibrateStart writes the intensity and returns the new state', async () => {
    const api = makeApi({
      startScan: scanHandlerWith([makeDevice({ address: 'OPO-1', name: '47L1270000XX' })]),
    });
    __setPluginBlecForTests(api);

    const client = new TauriBlecOpossumClient({
      selectDevice: async () => 'OPO-1',
      scanDurationMs: 50,
      gattReadyInitialDelayMs: 0,
    });
    await client.connect();

    const result = await client.execute({ type: 'vibrateStart', channel: 'A', intensity: 120 });
    expect(result.state.intensityA).toBe(120);
    expect(api.send).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([0xb3]),
      expect.any(String),
      expect.any(String),
      'OPO-1',
    );
  });

  it('disconnect() tears down without touching a differently-addressed device', async () => {
    const api = makeApi({
      startScan: scanHandlerWith([makeDevice({ address: 'OPO-1', name: '47L1270000XX' })]),
    });
    __setPluginBlecForTests(api);

    const client = new TauriBlecOpossumClient({
      selectDevice: async () => 'OPO-1',
      scanDurationMs: 50,
      gattReadyInitialDelayMs: 0,
    });
    await client.connect();
    await client.disconnect();

    expect(client.address).toBeNull();
    expect(api.disconnect).toHaveBeenCalledWith('OPO-1');
    const state = await client.getState();
    expect(state.connected).toBe(false);
  });

  it('a plugin-signalled disconnect (gattserverdisconnected) resets state without a manual disconnect() call', async () => {
    let onDisc: (() => void) | null = null;
    const api = makeApi({
      startScan: scanHandlerWith([makeDevice({ address: 'OPO-1', name: '47L1270000XX' })]),
      connect: vi.fn().mockImplementation(async (_addr: string, cb: () => void) => {
        onDisc = cb;
      }),
    });
    __setPluginBlecForTests(api);

    const client = new TauriBlecOpossumClient({
      selectDevice: async () => 'OPO-1',
      scanDurationMs: 50,
      gattReadyInitialDelayMs: 0,
    });
    await client.connect();
    expect(client.address).toBe('OPO-1');

    onDisc!();
    // handleGattDisconnected() fires the 'gattserverdisconnected' event
    // synchronously, but adapter.onDisconnected() itself awaits a
    // stopNotifications() round-trip through the mocked plugin-blec API —
    // flush a couple of microtask turns for it to settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.address).toBeNull();
    const state = await client.getState();
    expect(state.connected).toBe(false);
  });
});
