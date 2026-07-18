import { describe, expect, it, vi } from 'vitest';
import { createGattShim } from './gatt-shim.js';
import type { PluginBlecApi } from './plugin-blec.js';

function makeApi(overrides: Partial<PluginBlecApi> = {}): PluginBlecApi {
  return {
    checkPermissions: vi.fn().mockResolvedValue(true),
    startScan: vi.fn().mockResolvedValue(undefined),
    stopScan: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockResolvedValue([]),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('createGattShim', () => {
  it('gatt.disconnect() synchronously fires gattserverdisconnected', () => {
    const onDisconnect = vi.fn();
    const shim = createGattShim({
      address: 'AA:BB',
      name: 'Coyote',
      api: makeApi(),
      onDisconnect,
    });

    const seen: Event[] = [];
    shim.device.addEventListener('gattserverdisconnected', (e) => seen.push(e));

    shim.device.gatt!.disconnect();
    expect(seen).toHaveLength(1);
    expect(shim.server.connected).toBe(false);
    expect(shim.device.gatt!.connected).toBe(false);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it('repeated disconnects do not double-fire the event', () => {
    const onDisconnect = vi.fn();
    const shim = createGattShim({
      address: 'AA:BB',
      name: 'Coyote',
      api: makeApi(),
      onDisconnect,
    });

    const seen: Event[] = [];
    shim.device.addEventListener('gattserverdisconnected', (e) => seen.push(e));

    shim.device.gatt!.disconnect();
    shim.device.gatt!.disconnect();
    shim.fireDisconnect();

    expect(seen).toHaveLength(1);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it('plugin-side disconnect callback fires the event once', () => {
    const onDisconnect = vi.fn();
    const shim = createGattShim({
      address: 'AA:BB',
      name: 'Coyote',
      api: makeApi(),
      onDisconnect,
    });

    const seen: Event[] = [];
    shim.device.addEventListener('gattserverdisconnected', (e) => seen.push(e));

    shim.fireDisconnect();
    expect(seen).toHaveLength(1);
    expect(onDisconnect).toHaveBeenCalledTimes(1);

    // Subsequent gatt.disconnect() from the host must not re-fire.
    shim.device.gatt!.disconnect();
    expect(seen).toHaveLength(1);
  });

  it('does not implement requestMTU, since plugin-blec@0.8.0 has no MTU API', () => {
    // Intentional: see the comment above the `server` literal in gatt-shim.ts.
    // Faking a `requestMTU` that doesn't actually change the negotiated MTU
    // would be worse than omitting it (protocol adapters optional-chain on
    // it, so omitting is a safe no-op; a fake would silently lie).
    const shim = createGattShim({
      address: 'AA:BB',
      name: 'Coyote',
      api: makeApi(),
      onDisconnect: vi.fn(),
    });

    expect('requestMTU' in shim.server).toBe(false);
  });
});
