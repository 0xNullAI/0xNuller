import {
  currentDeviceLeaseSnapshot,
  registerSafetySession,
  subscribeSafetySessions,
  type DeviceSummary,
} from '@dg-kit/safety';
import type { CommandAck, DeviceSnapshot } from './contracts.js';
import type { WebEmbeddedDeviceRuntimeProvider } from './web-runtime-provider.js';

export const EMBEDDED_DEVICE_SAFETY_SESSION_ID = 'embedded-device-runtime';

export interface EmbeddedDeviceRuntimeSafetyControllerOptions {
  provider: WebEmbeddedDeviceRuntimeProvider;
  label?: string;
  document?: Document;
  window?: Window;
  reportStopFailure?: (error: unknown) => void;
  attachNativeLifecycle?: (stop: () => void) => void | (() => void) | Promise<void | (() => void)>;
}

/**
 * Shell-lifetime safety owner for the optional embedded runtime.
 *
 * It is intentionally not a React component: one controller is constructed beside the shell-owned
 * provider before render, so StrictMode and module effects cannot duplicate lifecycle listeners or
 * safety sessions.
 */
export class EmbeddedDeviceRuntimeSafetyController {
  private readonly provider: WebEmbeddedDeviceRuntimeProvider;
  private readonly reportStopFailure?: (error: unknown) => void;
  private readonly document?: Document;
  private readonly window?: Window;
  private readonly unregisterSession: () => void;
  private readonly unsubscribeLease: () => void;
  private detachNativeLifecycle: (() => void) | null = null;
  private leaseEpoch = currentDeviceLeaseSnapshot().epoch;
  private disposed = false;
  private interactionSequence = 0;

  private readonly onVisibilityChange = () => {
    if (this.document?.visibilityState === 'hidden') this.requestStop('visibility-hidden');
  };

  private readonly onPageHide = () => this.requestStop('pagehide');
  private readonly onFreeze = () => this.requestStop('freeze');

  constructor(options: EmbeddedDeviceRuntimeSafetyControllerOptions) {
    this.provider = options.provider;
    this.reportStopFailure = options.reportStopFailure;
    this.document = options.document ?? globalThis.document;
    this.window = options.window ?? globalThis.window;

    this.unregisterSession = registerSafetySession({
      id: EMBEDDED_DEVICE_SAFETY_SESSION_ID,
      label: options.label ?? '实验设备',
      isActive: () => this.deviceSummaries().length > 0,
      stop: () => this.stop('global-stop'),
      devices: () => this.deviceSummaries(),
      onRevoke: () => this.stop('lease-revoked'),
    });

    this.unsubscribeLease = subscribeSafetySessions(() => {
      const next = currentDeviceLeaseSnapshot();
      if (next.epoch === this.leaseEpoch) return;
      this.leaseEpoch = next.epoch;
      this.requestStop('lease-epoch-changed');
    });

    this.document?.addEventListener('visibilitychange', this.onVisibilityChange);
    this.document?.addEventListener('freeze', this.onFreeze);
    this.window?.addEventListener('pagehide', this.onPageHide);

    if (options.attachNativeLifecycle) {
      void Promise.resolve(
        options.attachNativeLifecycle(() => this.requestStop('native-lifecycle')),
      )
        .then((detach) => {
          if (typeof detach !== 'function') return;
          if (this.disposed) detach();
          else this.detachNativeLifecycle = detach;
        })
        .catch((error: unknown) => this.publishStopFailure(error));
    }
  }

  /** Device output cannot be inferred from successful writes, so active is deliberately omitted. */
  deviceSummaries(): DeviceSummary[] {
    const runtime = this.provider.current();
    return runtime ? summariesFromSnapshot(runtime.snapshot()) : [];
  }

  /** Stop without closing; the opted-in session remains available for an explicit human action. */
  async stop(reason = 'safety-stop'): Promise<void> {
    const runtime = this.provider.current();
    if (!runtime) return;
    let ack: CommandAck;
    try {
      ack = await runtime.forModule('embedded-device-safety').actions.emergencyStop({
        interactionId: this.interactionId(reason),
      });
    } catch (error) {
      this.publishStopFailure(error);
      throw error;
    }
    if (ack.status !== 'stopped') {
      const error = new Error(`Embedded device stop failed: ${ack.code}`);
      this.publishStopFailure(error);
      throw error;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unregisterSession();
    this.unsubscribeLease();
    this.document?.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.document?.removeEventListener('freeze', this.onFreeze);
    this.window?.removeEventListener('pagehide', this.onPageHide);
    this.detachNativeLifecycle?.();
    this.detachNativeLifecycle = null;
  }

  private requestStop(reason: string): void {
    void this.stop(reason).catch(() => {
      // stop() already published the failure; lifecycle and lease callbacks have no awaiter.
    });
  }

  private publishStopFailure(error: unknown): void {
    try {
      this.reportStopFailure?.(error);
    } catch {
      // Reporting must never interrupt the stop path.
    }
  }

  private interactionId(reason: string): string {
    this.interactionSequence += 1;
    return `shell-safety/${reason}/${this.interactionSequence}`;
  }
}

function summariesFromSnapshot(snapshot: DeviceSnapshot): DeviceSummary[] {
  return snapshot.devices.map((device) => {
    const battery = device.capabilities.find((capability) => capability.kind === 'battery');
    return {
      id: device.deviceId,
      kind: 'embedded-device',
      name: device.name,
      connected: true,
      ...(battery?.kind === 'battery' && battery.value !== null
        ? { battery: Math.round(battery.value * 100) }
        : {}),
      // `active` is absent: a transport acknowledgement cannot prove physical idle/output state.
    };
  });
}
