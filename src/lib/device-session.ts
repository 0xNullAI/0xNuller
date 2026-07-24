/**
 * Unified device layer: holds one client per DG-Lab device kind (all four
 * can be connected simultaneously and independently) and exposes a single
 * "connect a device" entry point that opens ONE chooser scoped to every
 * kind, auto-detects which kind was picked, and routes it to the matching
 * client.
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
  type CivetEdgingClient,
  type CivetPressureReading,
  type OpossumClient,
  type OpossumState,
  type PawPrintsClient,
  type PawPrintsReading,
} from '@dg-kit/protocol';
import type { DeviceClient, DeviceKind, DeviceState, SensorState } from '@dg-kit/core';
import {
  WebBluetoothCivetEdgingClient,
  WebBluetoothDeviceClient,
  WebBluetoothOpossumClient,
  WebBluetoothPawPrintsClient,
  requestDgLabDevice,
} from '@dg-kit/transport-webbluetooth';

export interface DeviceSessionState {
  coyote: DeviceState;
  opossum: OpossumState;
  pawPrints: SensorState;
  civetEdging: SensorState;
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
  pawPrints: PawPrintsClient & GattConnectable;
  civetEdging: CivetEdgingClient & GattConnectable;
  requestDevice(): Promise<RequestedDevice>;
}

/** The web app's default — every consumer that doesn't explicitly inject a Tauri transport gets this unchanged. */
export function createWebBluetoothTransport(): DeviceSessionTransport {
  return {
    coyote: new WebBluetoothDeviceClient({ protocol: new CoyoteProtocolAdapter(), autoReconnect: true }),
    opossum: new WebBluetoothOpossumClient(),
    pawPrints: new WebBluetoothPawPrintsClient(),
    civetEdging: new WebBluetoothCivetEdgingClient(),
    requestDevice: () => requestDgLabDevice(),
  };
}

/**
 * Owns exactly one client per kind and lets any number of them be connected
 * at once.
 */
export class DeviceSession {
  readonly coyote: DeviceSessionTransport['coyote'];
  readonly opossum: DeviceSessionTransport['opossum'];
  readonly pawPrints: DeviceSessionTransport['pawPrints'];
  readonly civetEdging: DeviceSessionTransport['civetEdging'];

  private readonly requestDevice: DeviceSessionTransport['requestDevice'];
  private readonly listeners = new Set<() => void>();

  constructor(transport: DeviceSessionTransport = createWebBluetoothTransport()) {
    this.coyote = transport.coyote;
    this.opossum = transport.opossum;
    this.pawPrints = transport.pawPrints;
    this.civetEdging = transport.civetEdging;
    this.requestDevice = transport.requestDevice;

    this.coyote.onStateChanged(() => this.emit());
    this.opossum.onStateChanged(() => this.emit());
    this.pawPrints.onStateChanged(() => this.emit());
    this.civetEdging.onStateChanged(() => this.emit());
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  /**
   * Opens one chooser scoped to every DG-Lab device kind and routes the
   * picked device to the matching client. Call repeatedly to connect
   * additional devices — each call opens a fresh chooser.
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
        await this.pawPrints.connectDevice(device, server);
        break;
      case 'civet-edging':
        await this.civetEdging.connectDevice(device, server);
        break;
    }

    return { kind, name: device.name ?? '' };
  }

  async disconnectCoyote(): Promise<void> {
    await this.coyote.disconnect();
  }

  async disconnectOpossum(): Promise<void> {
    await this.opossum.disconnect();
  }

  async disconnectPawPrints(): Promise<void> {
    await this.pawPrints.disconnect();
  }

  async disconnectCivetEdging(): Promise<void> {
    await this.civetEdging.disconnect();
  }

  /** Panic button: stop the two output-capable devices immediately. */
  async emergencyStop(): Promise<void> {
    await Promise.all([
      this.coyote.emergencyStop().catch(() => undefined),
      this.opossum.emergencyStop().catch(() => undefined),
    ]);
  }

  async getState(): Promise<DeviceSessionState> {
    const [coyote, opossum, pawPrints, civetEdging] = await Promise.all([
      this.coyote.getState(),
      this.opossum.getState(),
      this.pawPrints.getState(),
      this.civetEdging.getState(),
    ]);
    return { coyote, opossum, pawPrints, civetEdging };
  }

  subscribePawPrints(listener: (reading: PawPrintsReading) => void): () => void {
    return this.pawPrints.subscribe(listener);
  }

  subscribeCivetEdging(listener: (reading: CivetPressureReading) => void): () => void {
    return this.civetEdging.subscribe(listener);
  }
}
