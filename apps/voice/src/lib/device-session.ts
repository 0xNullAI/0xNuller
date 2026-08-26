/**
 * Unified device layer: holds one client per supported DG-Lab device kind
 * (Coyote + Opossum, connectable simultaneously and independently) and
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
  CoyoteProtocolAdapter,
  type BluetoothDeviceLike,
  type BluetoothRemoteGATTServerLike,
  type OpossumClient,
  type OpossumState,
  type RequestedDevice,
} from '@dg-kit/protocol';
import type { DeviceClient, DeviceKind, DeviceState } from '@dg-kit/core';
import {
  WebBluetoothDeviceClient,
  WebBluetoothOpossumClient,
  requestDgLabDevice,
} from '@dg-kit/transport-webbluetooth';

export interface DeviceSessionState {
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
    coyote: new WebBluetoothDeviceClient({
      protocol: new CoyoteProtocolAdapter(),
      autoReconnect: true,
    }),
    opossum: new WebBluetoothOpossumClient(),
    requestDevice: () => requestDgLabDevice(),
  };
}

const SENSOR_KIND_DISPLAY_NAME: Partial<Record<DeviceKind, string>> = {
  'paw-prints': '爪印',
  'civet-edging': '灵猫',
};

/** Owns exactly one client per supported kind and lets both be connected at once. */
export class DeviceSession {
  readonly coyote: DeviceSessionTransport['coyote'];
  readonly opossum: DeviceSessionTransport['opossum'];

  private readonly requestDevice: DeviceSessionTransport['requestDevice'];
  private readonly listeners = new Set<() => void>();
  private readonly targetIds: Record<'coyote' | 'opossum', string | null> = {
    coyote: null,
    opossum: null,
  };

  constructor(transport: DeviceSessionTransport = createWebBluetoothTransport()) {
    this.coyote = transport.coyote;
    this.opossum = transport.opossum;
    this.requestDevice = transport.requestDevice;

    this.coyote.onStateChanged((state) => {
      this.updateTargetIdentity('coyote', state.connected);
      this.emit();
    });
    this.opossum.onStateChanged((state) => {
      this.updateTargetIdentity('opossum', state.connected);
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
  currentTargetId(kind: 'coyote' | 'opossum'): string | null {
    return this.targetIds[kind];
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
        if ((await this.coyote.getState()).connected) {
          device.gatt?.disconnect();
          throw new Error('语音通话当前只支持一台郊狼；请先断开现有设备再连接另一台');
        }
        await this.coyote.connectDevice(device, server);
        this.updateTargetIdentity('coyote', true);
        break;
      }
      case 'opossum': {
        if ((await this.opossum.getState()).connected) {
          device.gatt?.disconnect();
          throw new Error('语音通话当前只支持一台负鼠；请先断开现有设备再连接另一台');
        }
        await this.opossum.connectDevice(device, server);
        this.updateTargetIdentity('opossum', true);
        break;
      }
      case 'paw-prints':
      case 'civet-edging':
        device.gatt?.disconnect();
        throw new Error(`语音通话暂不支持${SENSOR_KIND_DISPLAY_NAME[kind]}这类传感器设备`);
    }

    return { kind, name: device.name ?? '' };
  }

  async disconnectCoyote(): Promise<void> {
    await this.coyote.disconnect();
    this.updateTargetIdentity('coyote', false);
  }

  async disconnectOpossum(): Promise<void> {
    await this.opossum.disconnect();
    this.updateTargetIdentity('opossum', false);
  }

  /** Panic button: stop both devices immediately. */
  async emergencyStop(): Promise<void> {
    await Promise.all([
      this.coyote.emergencyStop().catch(() => undefined),
      this.opossum.emergencyStop().catch(() => undefined),
    ]);
  }

  async getState(): Promise<DeviceSessionState> {
    const [coyote, opossum] = await Promise.all([this.coyote.getState(), this.opossum.getState()]);
    this.updateTargetIdentity('coyote', coyote.connected);
    this.updateTargetIdentity('opossum', opossum.connected);
    return { coyote, opossum };
  }

  private updateTargetIdentity(kind: 'coyote' | 'opossum', connected: boolean): void {
    if (!connected) {
      this.targetIds[kind] = null;
      return;
    }
    if (this.targetIds[kind]) return;
    const entropy =
      globalThis.crypto?.randomUUID?.() ??
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    this.targetIds[kind] = `voice-${kind}/${entropy}`;
  }
}
