import { describe, expect, it, vi } from 'vitest';
import type { DeviceBackend, DeviceBackendSession } from './contracts.js';
import { SharedDeviceRuntimeProvider } from './runtime-provider.js';
import {
  WEB_EMBEDDED_DEVICES_STORAGE_KEY,
  readWebEmbeddedDevicesEnabled,
  writeWebEmbeddedDevicesEnabled,
} from './web-embedded-settings.js';
import {
  WebEmbeddedDeviceRuntimeProvider,
  WebEmbeddedDevicesDisabledError,
} from './web-runtime-provider.js';

function backendHarness() {
  const session: DeviceBackendSession = {
    scan: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    writeVibrate: vi.fn(async () => undefined),
    stopFeature: vi.fn(async () => undefined),
    stopAll: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const backend: DeviceBackend = {
    openSession: vi.fn(async () => session),
  };
  return { backend, session };
}

function executorOptions() {
  return {
    permissionPolicy: { authorize: async () => 'allow' as const },
    safetyPolicy: () => ({
      intensityCap: 1,
      maxIncrease: 1,
      coldStartCap: 1,
      maxOutputLeaseMs: 5_000,
    }),
    leaseSnapshot: () => ({ holder: null, epoch: 0 }),
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    values,
  };
}

describe('SharedDeviceRuntimeProvider', () => {
  it('shares one backend manager and stop barrier across all product surfaces', async () => {
    const harness = backendHarness();
    const provider = new SharedDeviceRuntimeProvider({
      backendFactory: () => harness.backend,
      executorOptions: executorOptions(),
    });

    const modules = await Promise.all(
      ['control', 'agent', 'voice', 'video'].map((moduleId) => provider.forModule(moduleId)),
    );
    const control = modules[0]!;
    const agent = modules[1]!;
    const voice = modules[2]!;
    const video = modules[3]!;

    expect(harness.backend.openSession).toHaveBeenCalledTimes(1);
    expect(control.actions.snapshot().sessionId).toBe(agent.actions.snapshot().sessionId);
    expect(agent.actions.snapshot().sessionId).toBe(voice.actions.snapshot().sessionId);
    expect(voice.actions.snapshot().sessionId).toBe(video.actions.snapshot().sessionId);

    await provider.stop();
    expect(harness.session.stopAll).toHaveBeenCalledTimes(1);
    expect(harness.session.close).toHaveBeenCalledTimes(1);
    expect(provider.current()).toBeNull();
  });
});

describe('Web embedded device opt-in', () => {
  it('is strict, local-only, and default-off', () => {
    const storage = memoryStorage();
    expect(readWebEmbeddedDevicesEnabled(storage)).toBe(false);

    storage.setItem(WEB_EMBEDDED_DEVICES_STORAGE_KEY, '{"version":1,"enabled":true,"remote":true}');
    expect(readWebEmbeddedDevicesEnabled(storage)).toBe(false);
    storage.setItem(WEB_EMBEDDED_DEVICES_STORAGE_KEY, '{broken');
    expect(readWebEmbeddedDevicesEnabled(storage)).toBe(false);

    expect(writeWebEmbeddedDevicesEnabled(true, storage)).toBe(true);
    expect(readWebEmbeddedDevicesEnabled(storage)).toBe(true);
    expect(JSON.parse(storage.values.get(WEB_EMBEDDED_DEVICES_STORAGE_KEY)!)).toEqual({
      version: 1,
      enabled: true,
    });
  });

  it('does not load a backend until local opt-in and reuses it after opt-in', async () => {
    const storage = memoryStorage();
    const harness = backendHarness();
    const provider = new WebEmbeddedDeviceRuntimeProvider({
      storage,
      backendFactory: () => harness.backend,
      executorOptions: executorOptions(),
    });

    expect(provider.isEnabled()).toBe(false);
    await expect(provider.start()).rejects.toBeInstanceOf(WebEmbeddedDevicesDisabledError);
    expect(harness.backend.openSession).not.toHaveBeenCalled();

    await provider.setEnabled(true);
    expect(harness.backend.openSession).not.toHaveBeenCalled();
    await Promise.all([provider.forModule('control'), provider.forModule('agent')]);
    expect(harness.backend.openSession).toHaveBeenCalledTimes(1);

    await provider.setEnabled(false);
    expect(provider.current()).toBeNull();
    expect(harness.session.stopAll).toHaveBeenCalledTimes(1);
    await expect(provider.forModule('voice')).rejects.toBeInstanceOf(
      WebEmbeddedDevicesDisabledError,
    );
  });

  it('does not persist false when stop/close cannot be confirmed', async () => {
    const storage = memoryStorage();
    const harness = backendHarness();
    const provider = new WebEmbeddedDeviceRuntimeProvider({
      storage,
      backendFactory: () => harness.backend,
      executorOptions: executorOptions(),
    });
    await provider.setEnabled(true);
    await provider.start();
    vi.mocked(harness.session.stopAll).mockRejectedValueOnce(new Error('stop failed'));

    await expect(provider.setEnabled(false)).rejects.toThrow('stop failed');
    await expect(provider.setEnabled(false)).rejects.toThrow('stop failed');
    expect(harness.session.stopAll).toHaveBeenCalledTimes(1);
    expect(readWebEmbeddedDevicesEnabled(storage)).toBe(true);
    await expect(provider.start()).rejects.toThrow('stop failed');
    await expect(provider.restart()).rejects.toThrow('stop failed');
    expect(harness.backend.openSession).toHaveBeenCalledTimes(1);
  });
});
