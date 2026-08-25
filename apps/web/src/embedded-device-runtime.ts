import {
  EmbeddedDeviceRuntimeSafetyController,
  WebEmbeddedDeviceRuntimeProvider,
  type DeviceBackend,
  type DeviceRuntimeExecutorOptions,
  type LocalDeviceSettingStorage,
} from '@0xnullai/device-runtime';
import { loadDeviceSafety } from '@0xnullai/settings';
import { reportStopFailure } from '@0xnullai/ui';
import { currentDeviceLeaseSnapshot } from '@dg-kit/safety';

export interface UnifiedShellEmbeddedDeviceRuntimeOptions {
  backendFactory: () => DeviceBackend;
  storage?: LocalDeviceSettingStorage | null;
  attachNativeLifecycle?: (stop: () => void) => void | (() => void) | Promise<void | (() => void)>;
}

/** Product policy shared by the Web and Android shell compositions. */
export function embeddedDeviceExecutorOptions(): DeviceRuntimeExecutorOptions {
  return {
    // Each AI surface performs its own permission/grant check first. This final
    // provider allowlist prevents any other module or room path reaching output.
    permissionPolicy: {
      authorize: async (request) =>
        ['control', 'agent', 'voice', 'video'].includes(request.moduleId) ? 'allow' : 'deny',
    },
    safetyPolicy: () => {
      const settings = loadDeviceSafety();
      return {
        // A generic feature has no A/B identity, so enforce the lower configured vibration cap.
        intensityCap: Math.min(
          1,
          Math.max(0, Math.min(settings.maxIntensityA, settings.maxIntensityB)) / 200,
        ),
        maxIncrease: Math.min(1, Math.max(0, settings.maxOpossumAdjustStep) / 200),
        coldStartCap: Math.min(1, Math.max(0, settings.maxColdStartIntensity) / 200),
        maxOutputLeaseMs: Math.max(1, Math.min(5_000, Math.floor(settings.maxBurstDurationMs))),
      };
    },
    leaseSnapshot: currentDeviceLeaseSnapshot,
  };
}

/** Construct exactly one provider/controller pair beside a unified shell, before React render. */
export function createUnifiedShellEmbeddedDeviceRuntime(
  options: UnifiedShellEmbeddedDeviceRuntimeOptions,
): {
  deviceRuntime: WebEmbeddedDeviceRuntimeProvider;
  safetyController: EmbeddedDeviceRuntimeSafetyController;
} {
  const deviceRuntime = new WebEmbeddedDeviceRuntimeProvider({
    storage: options.storage,
    backendFactory: options.backendFactory,
    executorOptions: embeddedDeviceExecutorOptions(),
  });
  const safetyController = new EmbeddedDeviceRuntimeSafetyController({
    provider: deviceRuntime,
    attachNativeLifecycle: options.attachNativeLifecycle,
    reportStopFailure: () => reportStopFailure('实验设备'),
  });
  return { deviceRuntime, safetyController };
}
