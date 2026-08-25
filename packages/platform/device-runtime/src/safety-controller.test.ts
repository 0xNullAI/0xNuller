import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentDeviceLeaseSnapshot, grantDeviceLease, safetySessionById } from '@dg-kit/safety';
import type { BackendEvent, DeviceBackend, DeviceBackendSession } from './contracts.js';
import { WebEmbeddedDeviceRuntimeProvider } from './web-runtime-provider.js';
import {
  EMBEDDED_DEVICE_SAFETY_SESSION_ID,
  EmbeddedDeviceRuntimeSafetyController,
} from './safety-controller.js';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  await grantDeviceLease(null);
});

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

async function harness(options: { stopAll?: () => Promise<void> } = {}) {
  let emit: ((event: unknown) => void) | null = null;
  const session: DeviceBackendSession = {
    scan: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    writeVibrate: vi.fn(async () => undefined),
    stopFeature: vi.fn(async () => undefined),
    stopAll: vi.fn(options.stopAll ?? (async () => undefined)),
    close: vi.fn(async () => undefined),
  };
  const backend: DeviceBackend = {
    openSession: vi.fn(async (onEvent) => {
      emit = onEvent;
      return session;
    }),
  };
  const storage = memoryStorage();
  const provider = new WebEmbeddedDeviceRuntimeProvider({
    storage,
    backendFactory: () => backend,
    executorOptions: {
      permissionPolicy: { authorize: async () => 'allow' },
      safetyPolicy: () => ({
        intensityCap: 1,
        maxIncrease: 1,
        coldStartCap: 1,
        maxOutputLeaseMs: 5_000,
      }),
      leaseSnapshot: currentDeviceLeaseSnapshot,
    },
  });
  await provider.setEnabled(true);
  await provider.start();
  cleanups.push(() => provider.stop().catch(() => undefined));
  return {
    provider,
    session,
    emit(event: BackendEvent) {
      if (!emit) throw new Error('backend not open');
      emit(event);
    },
  };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('EmbeddedDeviceRuntimeSafetyController', () => {
  it('registers one shell safety session and stops immediately on lease epoch handoff', async () => {
    const runtime = await harness();
    const controller = new EmbeddedDeviceRuntimeSafetyController({ provider: runtime.provider });
    cleanups.push(() => controller.dispose());

    expect(safetySessionById(EMBEDDED_DEVICE_SAFETY_SESSION_ID)).not.toBeNull();
    await grantDeviceLease('control');
    await tick();
    expect(runtime.session.stopAll).toHaveBeenCalledTimes(1);

    await grantDeviceLease('agent');
    await tick();
    expect(runtime.session.stopAll).toHaveBeenCalledTimes(2);
  });

  it('stops on hidden, pagehide, freeze, and a native lifecycle signal', async () => {
    const runtime = await harness();
    const nativeLifecycle: { stop?: () => void } = {};
    const controller = new EmbeddedDeviceRuntimeSafetyController({
      provider: runtime.provider,
      attachNativeLifecycle: (stop) => {
        nativeLifecycle.stop = stop;
      },
    });
    cleanups.push(() => controller.dispose());

    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await tick();
    expect(runtime.session.stopAll).toHaveBeenCalledTimes(1);
    visibility.mockRestore();

    window.dispatchEvent(new Event('pagehide'));
    await tick();
    expect(runtime.session.stopAll).toHaveBeenCalledTimes(2);

    document.dispatchEvent(new Event('freeze'));
    await tick();
    expect(runtime.session.stopAll).toHaveBeenCalledTimes(3);

    if (!nativeLifecycle.stop) throw new Error('native lifecycle listener not attached');
    nativeLifecycle.stop();
    await tick();
    expect(runtime.session.stopAll).toHaveBeenCalledTimes(4);
  });

  it('reports stop failure and never claims a connected feature is idle', async () => {
    const runtime = await harness({ stopAll: async () => Promise.reject(new Error('lost')) });
    runtime.emit({
      version: 1,
      type: 'topology',
      devices: [
        {
          nativeDeviceId: 'native-1',
          name: 'Exact device name',
          capabilities: [
            { kind: 'vibrate', nativeFeatureId: 'motor-1', stepCount: 20 },
            { kind: 'battery', nativeFeatureId: 'battery-1', value: 0.62 },
          ],
        },
      ],
    });
    const report = vi.fn();
    const controller = new EmbeddedDeviceRuntimeSafetyController({
      provider: runtime.provider,
      reportStopFailure: report,
    });
    cleanups.push(() => controller.dispose());

    const [summary] = controller.deviceSummaries();
    expect(summary).toMatchObject({ name: 'Exact device name', connected: true, battery: 62 });
    expect(summary).not.toHaveProperty('active');

    await expect(controller.stop()).rejects.toThrow('stop-failed');
    expect(report).toHaveBeenCalledTimes(1);
  });
});
