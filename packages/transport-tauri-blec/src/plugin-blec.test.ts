import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __setPluginBlecForTests,
  resolvePluginBlec,
  type PluginBlecApi,
} from './plugin-blec.js';

afterEach(() => {
  __setPluginBlecForTests(undefined);
});

describe('resolvePluginBlec', () => {
  it('returns the injected stub in tests', async () => {
    const stub: PluginBlecApi = {
      checkPermissions: vi.fn().mockResolvedValue(true),
      startScan: vi.fn().mockResolvedValue(undefined),
      stopScan: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      read: vi.fn().mockResolvedValue([]),
      subscribe: vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
    };
    __setPluginBlecForTests(stub);
    const api = await resolvePluginBlec();
    expect(api).toBe(stub);
  });

  it('throws a clear error when called outside Tauri without a stub', async () => {
    __setPluginBlecForTests(undefined);
    await expect(resolvePluginBlec()).rejects.toThrow(/plugin-blec/);
  });
});
