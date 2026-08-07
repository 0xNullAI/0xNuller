import { afterEach, describe, expect, it, vi } from 'vitest';
import { __setPluginBlecForTests, resolvePluginBlec } from './plugin-blec.js';
import { makeApi } from './test-utils.js';

afterEach(() => {
  __setPluginBlecForTests(undefined);
});

describe('resolvePluginBlec', () => {
  it('returns the injected stub in tests', async () => {
    const stub = makeApi();
    __setPluginBlecForTests(stub);
    const api = await resolvePluginBlec();
    expect(api).toBe(stub);
  });

  it('throws a clear error when called outside Tauri without a stub', async () => {
    __setPluginBlecForTests(undefined);
    await expect(resolvePluginBlec()).rejects.toThrow(/plugin-blec/);
  });
});

describe('resolvePluginBlec mapModule (real @mnlphlp/plugin-blec module shape)', () => {
  const originalWindow = (globalThis as { window?: unknown }).window;

  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
    vi.doUnmock('@mnlphlp/plugin-blec');
    vi.resetModules();
  });

  it('forwards the address argument through every address-taking call', async () => {
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };

    const mockMod = {
      checkPermissions: vi.fn().mockResolvedValue(true),
      startScan: vi.fn().mockResolvedValue(undefined),
      stopScan: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      connectedDevices: vi.fn().mockResolvedValue([]),
      getDeviceConnectionUpdates: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      read: vi.fn().mockResolvedValue([]),
      subscribe: vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      getMtu: vi.fn().mockResolvedValue(23),
    };
    vi.doMock('@mnlphlp/plugin-blec', () => mockMod);
    vi.resetModules();

    const { resolvePluginBlec: freshResolve } = await import('./plugin-blec.js');
    const api = await freshResolve();

    await api.disconnect('AA:BB');
    expect(mockMod.disconnect).toHaveBeenCalledWith('AA:BB');

    await api.send('char', [1, 2], 'withResponse', 'svc', 'AA:BB');
    expect(mockMod.send).toHaveBeenCalledWith('char', [1, 2], 'withResponse', 'svc', 'AA:BB');

    await api.read('char', 'svc', 'AA:BB');
    expect(mockMod.read).toHaveBeenCalledWith('char', 'svc', 'AA:BB');

    const handler = vi.fn();
    await api.subscribe('char', 'svc', handler, 'AA:BB');
    expect(mockMod.subscribe).toHaveBeenCalledWith('char', 'svc', handler, 'AA:BB');

    await api.unsubscribe('char', 'svc', 'AA:BB');
    expect(mockMod.unsubscribe).toHaveBeenCalledWith('char', 'svc', 'AA:BB');

    await api.getMtu('AA:BB');
    expect(mockMod.getMtu).toHaveBeenCalledWith('AA:BB');

    await api.connectedDevices();
    expect(mockMod.connectedDevices).toHaveBeenCalled();

    const connHandler = vi.fn();
    await api.getDeviceConnectionUpdates('AA:BB', connHandler);
    expect(mockMod.getDeviceConnectionUpdates).toHaveBeenCalledWith('AA:BB', connHandler);
  });
});
