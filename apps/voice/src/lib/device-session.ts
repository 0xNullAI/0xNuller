/**
 * Voice's view of the app's one DG-Lab registry: every connected Coyote as an exact target plus
 * the first connected Opossum. Voice opens no BLE link of its own. A device connected on 设备
 * or in another module is the same device here, and every write goes through the registry
 * handle, so the lease fence, holder re-clamp and the device's single queue apply on top of
 * Voice's own policies.
 *
 * DG-Voice does not drive the two read-only sensor kinds (paw-prints, civet-edging): there is
 * no output tool for them. The shared picker still lists every DG-Lab kind, so
 * `connectDevice()` reports a picked sensor with a clear message and leaves it attached for the
 * modules that use it.
 *
 * Only the 设备 page disconnects devices, so this session has no disconnect.
 */
import { type OpossumClient, type OpossumState } from '@dg-kit/protocol';
import {
  createEmptyDeviceState,
  type DeviceClient,
  type DeviceKind,
  type DeviceState,
} from '@dg-kit/core';
import type { CoyoteTargetRouter, CoyoteTargetSnapshot } from '@dg-agent/core';
import { createCoyoteTargetRouter } from '@dg-agent/agent-browser';
import {
  RegistryCoyoteClient,
  RegistryOpossumClient,
  type DgLabDeviceSnapshot,
  type DgLabModuleHandle,
} from '@0xnullai/device-runtime';

export interface DeviceSessionState {
  coyotes: CoyoteTargetSnapshot[];
  /** Primary compatibility projection for existing single-device UI. */
  coyote: DeviceState;
  opossum: OpossumState;
}

export interface ConnectedDeviceInfo {
  kind: DeviceKind;
  name: string;
}

/**
 * Voice borrows the app's one DG-Lab registry through its module handle. It opens no BLE link:
 * every write goes through the handle, so the lease fence, holder re-clamp and the device's
 * single queue apply on top of Voice's own policies.
 */
export interface RegistryDeviceSessionTransport {
  coyote: RegistryCoyoteClient;
  opossum: RegistryOpossumClient;
  connect(): Promise<DgLabDeviceSnapshot>;
  /** Fires after the registry stopped every output because Voice lost the lease. */
  onRevoked(listener: () => void): () => void;
}

/** Voice's view of the shared registry, gated by the lease under `handle.moduleId`. */
export function createRegistryTransport(handle: DgLabModuleHandle): RegistryDeviceSessionTransport {
  return {
    coyote: new RegistryCoyoteClient(handle),
    opossum: new RegistryOpossumClient(handle),
    connect: () => handle.connect(),
    onRevoked: (listener) => handle.onRevoked(listener),
  };
}

const SENSOR_KIND_DISPLAY_NAME: Partial<Record<DeviceKind, string>> = {
  'paw-prints': '爪印',
  'civet-edging': '灵猫',
};

/** Owns exact Coyote targets plus the transport-limited single Opossum client. */
export class DeviceSession {
  readonly coyote: DeviceClient;
  readonly opossum: OpossumClient;

  private readonly transport: RegistryDeviceSessionTransport;
  readonly coyoteTargetRouter: CoyoteTargetRouter;
  private readonly listeners = new Set<() => void>();
  private opossumTargetId: string | null = null;
  /** Physical identity behind `opossumTargetId`, when the client exposes one. */
  private opossumSourceId: string | null = null;

  constructor(transport: RegistryDeviceSessionTransport) {
    this.transport = transport;
    this.coyote = transport.coyote;
    this.opossum = transport.opossum;
    this.coyoteTargetRouter = createCoyoteTargetRouter(this.coyote);

    this.coyote.onStateChanged(() => this.emit());
    this.opossum.onStateChanged((state) => {
      this.updateOpossumTargetIdentity(state.connected);
      this.emit();
    });
  }

  /** Lease loss reported by the shared registry, after it already stopped every output. */
  onRevoked(listener: () => void): () => void {
    return this.transport.onRevoked(() => {
      listener();
      this.emit();
    });
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  /**
   * Opaque identity for the connected Opossum target. It is
   * intentionally unrelated to the advertised device name and changes after
   * every disconnect/reconnect so an approval cannot migrate to new hardware.
   */
  currentOpossumTargetId(): string | null {
    return this.opossumTargetId;
  }

  listCoyoteTargets(): Promise<CoyoteTargetSnapshot[]> {
    return this.coyoteTargetRouter.listTargets();
  }

  getCoyoteTargetState(targetId: string): Promise<DeviceState | null> {
    return this.coyoteTargetRouter.getTargetState(targetId);
  }

  /**
   * Opens the one shared picker. A device another module already attached is reused, not
   * reopened. Call again to add another device.
   */
  async connectDevice(): Promise<ConnectedDeviceInfo> {
    const picked = await this.transport.connect();
    if (picked.kind === 'paw-prints' || picked.kind === 'civet-edging') {
      // The registry owns the link and other modules may use the sensor, so keep it attached.
      throw new Error(`语音通话暂不支持${SENSOR_KIND_DISPLAY_NAME[picked.kind]}这类传感器设备`);
    }
    this.updateOpossumTargetIdentity((await this.opossum.getState()).connected);
    return { kind: picked.kind, name: picked.name };
  }

  /** Panic button: stop every Coyote target and the Opossum immediately. */
  async emergencyStop(): Promise<void> {
    const results = await Promise.allSettled([
      this.coyote.emergencyStop(),
      this.opossum.emergencyStop(),
    ]);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure) throw failure.reason;
  }

  async getState(): Promise<DeviceSessionState> {
    const [coyotes, opossum] = await Promise.all([
      this.coyoteTargetRouter.listTargets(),
      this.opossum.getState(),
    ]);
    this.updateOpossumTargetIdentity(opossum.connected);
    return {
      coyotes,
      coyote: coyotes[0]?.state ?? createEmptyDeviceState(),
      opossum,
    };
  }

  private updateOpossumTargetIdentity(connected: boolean): void {
    // The registry may hold more than one Opossum; Voice drives the first. When that primary
    // changes to other hardware, the old target id (and any approval bound to it) must not follow.
    const sourceId = connected
      ? ((this.opossum as { deviceId?: string | null }).deviceId ?? null)
      : null;
    if (!connected || sourceId !== this.opossumSourceId) {
      this.opossumTargetId = null;
      this.opossumSourceId = sourceId;
    }
    if (!connected) return;
    if (this.opossumTargetId) return;
    const entropy =
      globalThis.crypto?.randomUUID?.() ??
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    this.opossumTargetId = `voice-opossum/${entropy}`;
  }
}
