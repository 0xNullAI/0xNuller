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

export interface DeviceSessionTransport {
  coyote: DeviceClient & GattConnectable;
  opossum: OpossumClient & GattConnectable;
  requestDevice(): Promise<RequestedDevice>;
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
  readonly coyote: DeviceSessionTransport['coyote'];
  readonly opossum: DeviceSessionTransport['opossum'];

  private readonly requestDevice: DeviceSessionTransport['requestDevice'];
  readonly coyoteTargetRouter: CoyoteTargetRouter;
  private readonly listeners = new Set<() => void>();
  private opossumTargetId: string | null = null;

  constructor(transport: DeviceSessionTransport = createWebBluetoothTransport()) {
    this.coyote = transport.coyote;
    this.opossum = transport.opossum;
    this.requestDevice = transport.requestDevice;
    this.coyoteTargetRouter = createCoyoteTargetRouter(this.coyote);

    this.coyote.onStateChanged(() => this.emit());
    this.opossum.onStateChanged((state) => {
      this.updateOpossumTargetIdentity(state.connected);
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
    const { kind, device, server } = await this.requestDevice();

    switch (kind) {
      case 'coyote': {
        await this.coyote.connectDevice(device, server);
        break;
      }
      case 'opossum': {
        if ((await this.opossum.getState()).connected) {
          device.gatt?.disconnect();
          throw new Error('语音通话当前只支持一台负鼠；请先断开现有设备再连接另一台');
        }
        await this.opossum.connectDevice(device, server);
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
    if (!connected) {
      this.opossumTargetId = null;
      return;
    }
    if (this.opossumTargetId) return;
    const entropy =
      globalThis.crypto?.randomUUID?.() ??
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    this.opossumTargetId = `voice-opossum/${entropy}`;
  }
}
