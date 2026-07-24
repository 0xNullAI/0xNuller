/**
 * Unified device layer: holds one client per DG-Lab device kind (all four
 * can be connected simultaneously and independently) and exposes a single
 * "connect a device" entry point that opens ONE Web Bluetooth chooser
 * scoped to every kind, auto-detects which kind was picked via
 * `requestDgLabDevice()`, and routes it to the matching client.
 *
 * Everything here comes straight from `@dg-kit/*` — the browser client
 * implementations (`WebBluetoothDeviceClient`, `WebBluetoothOpossumClient`,
 * `WebBluetoothPawPrintsClient`, `WebBluetoothCivetEdgingClient`) and the
 * unified picker (`requestDgLabDevice`) were extracted there in 1.13.0
 * specifically so a new consumer like this one doesn't need to hand-roll
 * per-kind connect logic the way DG-Chat's `DeviceSession` does.
 */
import {
  CoyoteProtocolAdapter,
  type CivetPressureReading,
  type OpossumState,
  type PawPrintsReading,
} from '@dg-kit/protocol';
import type { DeviceKind, DeviceState, SensorState } from '@dg-kit/core';
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

/**
 * Owns exactly one client per kind and lets any number of them be connected
 * at once. Coyote's client is created fresh per `DeviceSession` instance
 * (it owns a `CoyoteProtocolAdapter`); the other three are the plain
 * `@dg-kit/transport-webbluetooth` classes with no extra wrapping needed.
 */
export class DeviceSession {
  readonly coyote: WebBluetoothDeviceClient;
  readonly opossum: WebBluetoothOpossumClient = new WebBluetoothOpossumClient();
  readonly pawPrints: WebBluetoothPawPrintsClient = new WebBluetoothPawPrintsClient();
  readonly civetEdging: WebBluetoothCivetEdgingClient = new WebBluetoothCivetEdgingClient();

  private readonly listeners = new Set<() => void>();

  constructor() {
    this.coyote = new WebBluetoothDeviceClient({
      protocol: new CoyoteProtocolAdapter(),
      autoReconnect: true,
    });
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
    const { kind, device, server } = await requestDgLabDevice();

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
