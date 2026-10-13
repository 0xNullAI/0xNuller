import {
  DgLabConnectionRegistry,
  startBackgroundOutputController,
  type DgLabBackgroundStopReason,
  type DgLabTransport,
} from '@0xnullai/device-runtime';
import {
  backgroundKeepMs,
  loadDeviceSafety,
  setBackgroundKeepSupport,
  subscribeDeviceSafety,
  type BackgroundKeepSupport,
} from '@0xnullai/settings';
import { reportStopFailure } from '@0xnullai/ui';

export interface UnifiedShellDgLabRegistryOptions {
  transport: DgLabTransport;
  /**
   * Native shells hand over their own "the app is leaving the screen" signals and the stops their
   * native layer already carried out (`at`: when). Web omits it: a background tab keeps its
   * timers, so the stop button stays reachable without it.
   */
  attachNativeLifecycle?: (
    stop: NativeLifecycleStop,
  ) => void | (() => void) | Promise<void | (() => void)>;
  /**
   * How long output may keep running in the background when the user chose a keep duration. The
   * web shell's background timers keep firing; the Android shell keeps only through its native
   * foreground service, so it builds its support from the registry (to tell the service whether
   * any output is active).
   */
  backgroundKeep:
    BackgroundKeepSupport | ((registry: DgLabConnectionRegistry) => BackgroundKeepSupport);
}

export type NativeLifecycleStop = (reason?: DgLabBackgroundStopReason, at?: number) => void;

const STOP_FAILURE_LABEL = 'DG-Lab 设备';

/**
 * Construct the one DG-Lab connection registry for a unified shell, before React render.
 *
 * Limits are read through `loadDeviceSafety()` at every write, so a lowered setting also applies
 * to work already queued; each device's own limits (`@0xnullai/settings` device limits) lower
 * them further, and a change to either stops a device whose output is now above its cap. The
 * settings page reads and edits per-device limits through `listDeviceLimits()`,
 * `subscribeDeviceLimits()`, `setOwnLimits()` and `forgetDeviceLimits()` on this registry
 * (`useNativeBridge().dglab`), with no lease. The registry's `dglab-devices` safety session lists nothing until a
 * module connects through it.
 */
export function createUnifiedShellDgLabRegistry(
  options: UnifiedShellDgLabRegistryOptions,
): DgLabConnectionRegistry {
  const registry = new DgLabConnectionRegistry({
    transport: options.transport,
    limits: loadDeviceSafety,
    subscribeLimits: (listener) => subscribeDeviceSafety(() => listener()),
  });

  // Shell lifetime: the registry is never disposed while the app runs, so detaches are unused.
  setBackgroundKeepSupport(
    typeof options.backgroundKeep === 'function'
      ? options.backgroundKeep(registry)
      : options.backgroundKeep,
  );
  const controller = startBackgroundOutputController({
    registry,
    keepMs: backgroundKeepMs,
    onStopFailure: () => reportStopFailure(STOP_FAILURE_LABEL),
  });

  if (options.attachNativeLifecycle) {
    // Through the controller, reported as a background stop so modules (and the AI) learn why
    // output ended and a late hide event cannot start a hold the native side refused.
    const stop: NativeLifecycleStop = (reason = 'background', at) => controller.stop(reason, at);
    void Promise.resolve(options.attachNativeLifecycle(stop)).catch(() =>
      reportStopFailure(STOP_FAILURE_LABEL),
    );
  }

  return registry;
}
