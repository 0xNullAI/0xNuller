import type { DeviceClient, SensorDeviceClient } from '@dg-kit/core';
import type {
  BluetoothDeviceLike,
  BluetoothRemoteGATTServerLike,
  CivetPressureReading,
  NavigatorBluetoothLike,
  OpossumClient,
  PawPrintsReading,
  RequestedDevice,
  WebBluetoothProtocolAdapter,
} from '@dg-kit/protocol';
import {
  WebBluetoothCivetEdgingClient,
  WebBluetoothDeviceClient,
  WebBluetoothOpossumClient,
  WebBluetoothPawPrintsClient,
  requestDgLabDevice,
} from '@dg-kit/transport-webbluetooth';

export type DgLabSensorKind = 'paw-prints' | 'civet-edging';
export type DgLabSensorReading = PawPrintsReading | CivetPressureReading;

/** Attach to a `(device, server)` pair that the shared picker already GATT-connected. */
interface AttachesPickedDevice {
  connectDevice(device: BluetoothDeviceLike, server: BluetoothRemoteGATTServerLike): Promise<void>;
}

export type DgLabCoyoteClient = DeviceClient & AttachesPickedDevice;
export type DgLabOpossumClient = OpossumClient & AttachesPickedDevice;
export type DgLabSensorClient = SensorDeviceClient<DgLabSensorReading> & AttachesPickedDevice;

/**
 * Everything the registry needs from a BLE stack, and nothing about protocols.
 *
 * Web Bluetooth and Tauri plugin-blec both already ship a cross-kind picker and per-kind clients
 * with `connectDevice()`; a transport only composes them. Each `create*` call must return a new
 * client owning its own protocol adapter, because one adapter can reach only one device.
 */
export interface DgLabTransport {
  /** One shared chooser for every DG-Lab kind. Resolves with GATT already connected. */
  requestDevice(): Promise<RequestedDevice>;
  /** `protocol` is the one Coyote adapter (and tick loop) for this physical device. */
  createCoyoteClient(protocol: WebBluetoothProtocolAdapter): DgLabCoyoteClient;
  createOpossumClient(): DgLabOpossumClient;
  createSensorClient(kind: DgLabSensorKind): DgLabSensorClient;
}

export interface WebBluetoothDgLabTransportOptions {
  navigatorRef?: NavigatorBluetoothLike;
  /**
   * Silent Coyote reconnect with the cached device after a passive drop. Safe only because the
   * registry zeroes output on every connected edge and the lease, not the link, is the control
   * boundary. Defaults to true.
   */
  autoReconnectCoyote?: boolean;
}

/** The browser transport, built from the published kit clients without copying protocol code. */
export function createWebBluetoothDgLabTransport(
  options: WebBluetoothDgLabTransportOptions = {},
): DgLabTransport {
  const { navigatorRef, autoReconnectCoyote = true } = options;
  return {
    requestDevice: () => requestDgLabDevice({ navigatorRef }),
    createCoyoteClient: (protocol) =>
      new WebBluetoothDeviceClient({ protocol, navigatorRef, autoReconnect: autoReconnectCoyote }),
    createOpossumClient: () => new WebBluetoothOpossumClient({ navigatorRef }),
    createSensorClient: (kind) =>
      kind === 'paw-prints'
        ? (new WebBluetoothPawPrintsClient({ navigatorRef }) as DgLabSensorClient)
        : (new WebBluetoothCivetEdgingClient({ navigatorRef }) as DgLabSensorClient),
  };
}
