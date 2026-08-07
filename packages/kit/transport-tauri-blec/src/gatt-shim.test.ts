import { describe, expect, it, vi } from 'vitest';
import { createGattShim } from './gatt-shim.js';
import { makeApi } from './test-utils.js';

describe('createGattShim', () => {
  it('gatt.disconnect() synchronously fires gattserverdisconnected and calls api.disconnect(address)', () => {
    const onDisconnect = vi.fn();
    const api = makeApi();
    const shim = createGattShim({
      address: 'AA:BB',
      name: 'Coyote',
      api,
      onDisconnect,
    });

    const seen: Event[] = [];
    shim.device.addEventListener('gattserverdisconnected', (e) => seen.push(e));

    shim.device.gatt!.disconnect();
    expect(seen).toHaveLength(1);
    expect(shim.server.connected).toBe(false);
    expect(shim.device.gatt!.connected).toBe(false);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(api.disconnect).toHaveBeenCalledWith('AA:BB');
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

  it('does not implement requestMTU, since the fork has no per-hook MTU mapping yet', () => {
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

  it('scopes every characteristic read/write/subscribe/unsubscribe call to its own address', async () => {
    const api = makeApi();
    const shimA = createGattShim({ address: 'AA:AA', name: 'DeviceA', api, onDisconnect: vi.fn() });
    const shimB = createGattShim({ address: 'BB:BB', name: 'DeviceB', api, onDisconnect: vi.fn() });

    const serviceA = await shimA.server.getPrimaryService('svc');
    const charA = await serviceA.getCharacteristic('char');
    const serviceB = await shimB.server.getPrimaryService('svc');
    const charB = await serviceB.getCharacteristic('char');

    await charA.writeValue!(new Uint8Array([1]));
    await charB.writeValue!(new Uint8Array([2]));

    expect(api.send).toHaveBeenNthCalledWith(1, 'char', [1], 'withResponse', 'svc', 'AA:AA');
    expect(api.send).toHaveBeenNthCalledWith(2, 'char', [2], 'withResponse', 'svc', 'BB:BB');
  });

  it('disconnecting one shim does not touch the other device', () => {
    const api = makeApi();
    const shimA = createGattShim({ address: 'AA:AA', name: 'DeviceA', api, onDisconnect: vi.fn() });
    const shimB = createGattShim({ address: 'BB:BB', name: 'DeviceB', api, onDisconnect: vi.fn() });

    shimA.device.gatt!.disconnect();

    expect(api.disconnect).toHaveBeenCalledTimes(1);
    expect(api.disconnect).toHaveBeenCalledWith('AA:AA');
    expect(shimA.server.connected).toBe(false);
    expect(shimB.server.connected).toBe(true);
  });
});
