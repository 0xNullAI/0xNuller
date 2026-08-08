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

export interface RequestedDevice {
  kind: DeviceKind;
  device: BluetoothDeviceLike;
  server: BluetoothRemoteGATTServerLike;
}

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

  constructor(transport: DeviceSessionTransport = createWebBluetoothTransport()) {
    this.coyote = transport.coyote;
    this.opossum = transport.opossum;
    this.requestDevice = transport.requestDevice;

    this.coyote.onStateChanged(() => this.emit());
    this.opossum.onStateChanged(() => this.emit());
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  /**
   * Opens one chooser and routes the picked device to the matching client.
   * Call repeatedly to connect the other device kind — each call opens a
   * fresh chooser.
   */
  async connectDevice(): Promise<ConnectedDeviceInfo> {
    const { kind, device, server } = await this.requestDevice();

    switch (kind) {
      case 'coyote':
        await this.coyote.connectDevice(device, server);
        break;
      case 'opossum':
        await this.opossum.connectDevice(device, server);
        break;
      case 'paw-prints':
      case 'civet-edging':
        throw new Error(`语音通话暂不支持${SENSOR_KIND_DISPLAY_NAME[kind]}这类传感器设备`);
    }

    return { kind, name: device.name ?? '' };
  }

  async disconnectCoyote(): Promise<void> {
    await this.coyote.disconnect();
  }

  async disconnectOpossum(): Promise<void> {
    await this.opossum.disconnect();
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
    return { coyote, opossum };
  }
}
