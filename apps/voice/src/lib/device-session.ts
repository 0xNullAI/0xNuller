/**
 * Unified device layer: holds a shared multi-Coyote aggregate plus one
 * Opossum client (connectable simultaneously and independently) and
 * exposes a single "connect a device" entry point that opens ONE chooser,
 * auto-detects which kind was picked, and routes it to the matching client.
 *
 * DG-Voice deliberately does not support the two read-only sensor kinds
 * (paw-prints, civet-edging) — there is no output tool for them and no
 * event-stream-into-realtime-session wiring, so a connected sensor would
 * just sit there doing nothing useful. `requestDgLabDevice()`'s underlying
 * scan filter still matches every DG-Lab kind (that's baked into the kit),
 * so a user could still pick one in the browser's Bluetooth chooser —
 * `connectDevice()` rejects that pick with a clear message instead of
 * silently wiring up something nothing in this app knows how to use.
 *
 * Transport-injectable so the same class serves both the web app
 * (`createWebBluetoothTransport()`, the default) and the Android shell
 * (`@dg-kit/transport-tauri-blec`'s classes, wired up in
 * `apps/tauri-android`) — `requestDgLabDeviceTauri()` was deliberately built
 * to return the exact same `{kind, device, server}` shape as
 * `requestDgLabDevice()` (see that package's `request-device.ts`), and
 * every Tauri client exposes the same `connectDevice(device, server)`
 * passthrough as its Web Bluetooth counterpart, so no branching is needed
 * inside `connectDevice()` below — only which concrete clients and which
 * picker function get constructed differs, and that's exactly what
 * `DeviceSessionTransport` isolates.
 *
 * Inside a shell, Voice no longer opens links itself: `createRegistryTransport()` wraps the
 * app's one DG-Lab registry handle, and the legacy transports above are only the fallback.
 */
import {
  type BluetoothDeviceLike,
  type BluetoothRemoteGATTServerLike,
  type OpossumClient,
  type OpossumState,
  type RequestedDevice,
} from '@dg-kit/protocol';
import {
  createEmptyDeviceState,
  type DeviceClient,
  type DeviceKind,
  type DeviceState,
} from '@dg-kit/core';
import type { CoyoteTargetRouter, CoyoteTargetSnapshot } from '@dg-agent/core';
import { createCoyoteTargetRouter, MultiCoyoteDeviceClient } from '@dg-agent/agent-browser';
import {
  WebBluetoothDeviceClient,
  WebBluetoothOpossumClient,
  requestDgLabDevice,
} from '@dg-kit/transport-webbluetooth';
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

/** What every concrete client (Web Bluetooth or Tauri BLE) additionally exposes beyond its formal `@dg-kit/*` interface — the "already scanned and connected, just wire me up" passthrough `requestDevice()`'s result routes to. */
export interface GattConnectable {
  connectDevice(device: BluetoothDeviceLike, server: BluetoothRemoteGATTServerLike): Promise<void>;
}

/**
 * A picked, already-GATT-connected DG-Lab device plus its identified kind.
 * Declared in `@dg-kit/protocol` (both pickers return it); re-exported so
 * transport implementations only need this module.
 */
export type { RequestedDevice };

/**
 * Legacy: Voice opens and owns its own BLE links. Kept only as the fallback for a shell that
 * injects `voice.transport` without a shared DG-Lab registry.
 */
export interface DeviceSessionTransport {
  coyote: DeviceClient & GattConnectable;
  opossum: OpossumClient & GattConnectable;
  requestDevice(): Promise<RequestedDevice>;
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

export type AnyDeviceSessionTransport = DeviceSessionTransport | RegistryDeviceSessionTransport;

/** Voice's view of the shared registry, gated by the lease under `handle.moduleId`. */
export function createRegistryTransport(handle: DgLabModuleHandle): RegistryDeviceSessionTransport {
  return {
    coyote: new RegistryCoyoteClient(handle),
    opossum: new RegistryOpossumClient(handle),
    connect: () => handle.connect(),
    onRevoked: (listener) => handle.onRevoked(listener),
  };
}

function isRegistryTransport(
  transport: AnyDeviceSessionTransport,
): transport is RegistryDeviceSessionTransport {
  return 'connect' in transport && !('requestDevice' in transport);
}

/** The web app's default — every consumer that doesn't explicitly inject a Tauri transport gets this unchanged. */
export function createWebBluetoothTransport(): DeviceSessionTransport {
  return {
    coyote: new MultiCoyoteDeviceClient(
      (protocol) => new WebBluetoothDeviceClient({ protocol, autoReconnect: true }),
    ),
    opossum: new WebBluetoothOpossumClient(),
    requestDevice: () => requestDgLabDevice(),
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
  /** True when the shared DG-Lab registry owns the links; the shell lists its devices then. */
  readonly sharedRegistry: boolean;

  private readonly transport: AnyDeviceSessionTransport;
  readonly coyoteTargetRouter: CoyoteTargetRouter;
  private readonly listeners = new Set<() => void>();
  private opossumTargetId: string | null = null;
  /** Physical identity behind `opossumTargetId`, when the client exposes one. */
  private opossumSourceId: string | null = null;

  constructor(transport: AnyDeviceSessionTransport = createWebBluetoothTransport()) {
    this.transport = transport;
    this.coyote = transport.coyote;
    this.opossum = transport.opossum;
    this.sharedRegistry = isRegistryTransport(transport);
    this.coyoteTargetRouter = createCoyoteTargetRouter(this.coyote);

    this.coyote.onStateChanged(() => this.emit());
    this.opossum.onStateChanged((state) => {
      this.updateOpossumTargetIdentity(state.connected);
      this.emit();
    });
  }

  /**
   * Lease loss reported by the shared registry, after it already stopped every output. The
   * legacy transport has no such signal; the safety bus's `onRevoke` covers it.
   */
  onRevoked(listener: () => void): () => void {
    if (!isRegistryTransport(this.transport)) return () => undefined;
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
   * Opaque identity for the one connected legacy target of this kind. It is
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
   * Opens one chooser and routes the picked device to the matching client.
   * Call repeatedly to connect the other device kind — each call opens a
   * fresh chooser.
   */
  async connectDevice(): Promise<ConnectedDeviceInfo> {
    const transport = this.transport;
    if (isRegistryTransport(transport)) {
      const picked = await transport.connect();
      if (picked.kind === 'paw-prints' || picked.kind === 'civet-edging') {
        // The registry owns the link and other modules may use the sensor, so keep it attached.
        throw new Error(`语音通话暂不支持${SENSOR_KIND_DISPLAY_NAME[picked.kind]}这类传感器设备`);
      }
      this.updateOpossumTargetIdentity((await this.opossum.getState()).connected);
      return { kind: picked.kind, name: picked.name };
    }

    const { kind, device, server } = await transport.requestDevice();

    switch (kind) {
      case 'coyote': {
        await transport.coyote.connectDevice(device, server);
        break;
      }
      case 'opossum': {
        if ((await this.opossum.getState()).connected) {
          device.gatt?.disconnect();
          throw new Error('语音通话当前只支持一台负鼠；请先断开现有设备再连接另一台');
        }
        await transport.opossum.connectDevice(device, server);
        this.updateOpossumTargetIdentity(true);
        break;
      }
      case 'paw-prints':
      case 'civet-edging':
        device.gatt?.disconnect();
        throw new Error(`语音通话暂不支持${SENSOR_KIND_DISPLAY_NAME[kind]}这类传感器设备`);
    }

    return { kind, name: device.name ?? '' };
  }

  async disconnectCoyote(targetId?: string): Promise<void> {
    const multi = this.coyote as DeviceClient & {
      disconnectDeviceById?: (id: string) => Promise<void>;
    };
    if (targetId && multi.disconnectDeviceById) await multi.disconnectDeviceById(targetId);
    else await this.coyote.disconnect();
  }

  async disconnectOpossum(): Promise<void> {
    await this.opossum.disconnect();
    this.updateOpossumTargetIdentity(false);
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
