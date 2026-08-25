import { afterEach, describe, expect, it, vi } from 'vitest';
import { safetySessionById } from '@dg-kit/safety';
import type { DeviceBackend, DeviceBackendSession } from '@0xnullai/device-runtime';
import {
  EMBEDDED_DEVICE_SAFETY_SESSION_ID,
  WebEmbeddedDevicesDisabledError,
} from '@0xnullai/device-runtime';
import { createUnifiedShellEmbeddedDeviceRuntime } from './embedded-device-runtime';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

function backendHarness() {
  const session: DeviceBackendSession = {
    scan: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    writeVibrate: vi.fn(async () => undefined),
    stopFeature: vi.fn(async () => undefined),
    stopAll: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const backend: DeviceBackend = { openSession: vi.fn(async () => session) };
  const factory = vi.fn(() => backend);
  return { factory, backend };
}

describe('unified shell embedded device composition', () => {
  it('constructs one shared provider before render without loading the default-off backend', async () => {
    const backend = backendHarness();
    const composition = createUnifiedShellEmbeddedDeviceRuntime({
      backendFactory: backend.factory,
      storage: memoryStorage(),
    });
    cleanups.push(() => composition.safetyController.dispose());
    cleanups.push(() => composition.deviceRuntime.stop());

    expect(composition.deviceRuntime.isEnabled()).toBe(false);
    expect(safetySessionById(EMBEDDED_DEVICE_SAFETY_SESSION_ID)).not.toBeNull();
    await expect(composition.deviceRuntime.forModule('control')).rejects.toBeInstanceOf(
      WebEmbeddedDevicesDisabledError,
    );
    expect(backend.factory).not.toHaveBeenCalled();

    await composition.deviceRuntime.setEnabled(true);
    await Promise.all([
      composition.deviceRuntime.forModule('control'),
      composition.deviceRuntime.forModule('agent'),
    ]);
    expect(backend.factory).toHaveBeenCalledTimes(1);
    expect(backend.backend.openSession).toHaveBeenCalledTimes(1);
  });
});
