import type { DeviceKind } from '@dg-kit/core';
import {
  DG_LAB_REQUEST_DEVICE_OPTIONS,
  detectDeviceKind,
  type BluetoothDeviceLike,
  type BluetoothRemoteGATTServerLike,
  type NavigatorBluetoothLike,
  type RequestDeviceOptionsLike,
} from '@dg-kit/protocol';
import { getWebBluetoothAvailability } from './availability.js';

export interface RequestDgLabDeviceOptions {
  navigatorRef?: NavigatorBluetoothLike;
  requestDeviceOptions?: RequestDeviceOptionsLike;
}

export interface RequestedDgLabDevice {
  kind: DeviceKind;
  device: BluetoothDeviceLike;
  server: BluetoothRemoteGATTServerLike;
}

/**
 * Open ONE shared Web Bluetooth chooser scoped to every known DG-Lab device
 * kind (Coyote V2/V3, paw-prints, civet-edging, Opossum — see
 * `DG_LAB_REQUEST_DEVICE_OPTIONS`), connect its GATT server, and identify
 * which kind was picked via `detectDeviceKind()`.
 *
 * This is the shared foundation for a single "连接设备" entry point that can
 * pick up any of the four device kinds, auto-detected by name, instead of a
 * separate chooser per kind. Callers route the returned `(kind, device,
 * server)` to the right adapter/client themselves — e.g. a Coyote pick goes
 * to `WebBluetoothDeviceClient.connectDevice()`, a sensor/Opossum pick goes
 * straight to that device's own protocol adapter's `onConnected()`.
 *
 * Rejects (and disconnects) on an unrecognized device name — the chooser's
 * `filters` already scope results to DG-Lab prefixes, so this should only
 * trigger if a device happens to advertise a matching prefix without
 * actually being a DG-Lab device.
 */
export async function requestDgLabDevice(
  options: RequestDgLabDeviceOptions = {},
): Promise<RequestedDgLabDevice> {
  const nav =
    options.navigatorRef ??
    (typeof navigator === 'undefined' ? undefined : (navigator as unknown as NavigatorBluetoothLike));

  const availability = getWebBluetoothAvailability(nav);
  if (!availability.supported) {
    throw new Error(availability.reason);
  }

  const bluetooth = nav?.bluetooth;
  if (!bluetooth) {
    throw new Error('当前环境不支持 Web Bluetooth');
  }

  const device = await bluetooth.requestDevice(
    options.requestDeviceOptions ?? DG_LAB_REQUEST_DEVICE_OPTIONS,
  );
  const kind = detectDeviceKind(device.name);

  if (kind === 'unknown') {
    if (device.gatt?.connected) {
      device.gatt.disconnect();
    }
    throw new Error('未识别的设备，请确认选择了正确的 DG-Lab 设备');
  }

  const gatt = device.gatt;
  if (!gatt) {
    throw new Error('所选蓝牙设备不支持 GATT');
  }

  try {
    const server = await gatt.connect();
    return { kind, device, server };
  } catch (error) {
    if (gatt.connected) {
      gatt.disconnect();
    }
    throw error;
  }
}
