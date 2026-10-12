import { DgLabConnectionRegistry, type DgLabTransport } from '@0xnullai/device-runtime';
import { loadDeviceSafety, subscribeDeviceSafety } from '@0xnullai/settings';
import { reportStopFailure } from '@0xnullai/ui';

export interface UnifiedShellDgLabRegistryOptions {
  transport: DgLabTransport;
  /**
   * Native shells hand over their own "the app is leaving the screen" signals. Web omits it: a
   * background tab keeps its timers, so the stop button stays reachable without it.
   */
  attachNativeLifecycle?: (stop: () => void) => void | (() => void) | Promise<void | (() => void)>;
}

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

  if (options.attachNativeLifecycle) {
    // Shell lifetime: the registry is never disposed while the app runs, so the detach is unused.
    const stop = () => {
      void registry.stopAll().then(
        (result) => {
          if (result.failed.length > 0) reportStopFailure(STOP_FAILURE_LABEL);
        },
        () => reportStopFailure(STOP_FAILURE_LABEL),
      );
    };
    void Promise.resolve(options.attachNativeLifecycle(stop)).catch(() =>
      reportStopFailure(STOP_FAILURE_LABEL),
    );
  }

  return registry;
}
