/**
 * Shared connect/disconnect bookkeeping for the "auxiliary" device kinds
 * (Opossum, paw-prints, civet-edging) on Tauri, mirroring DG-Agent's
 * `device-webbluetooth` package's `connectAuxDevice`/`disconnectAuxDevice`
 * (browser/Web Bluetooth) almost exactly — the only real difference is how
 * a device gets picked and connected: Web Bluetooth uses
 * `navigator.bluetooth.requestDevice()`, this uses `scanAndSelectDevice()`
 * (plugin-blec scan + host-supplied picker) followed by `api.connect()` and
 * `createGattShim()`. Once a `(device, server)` pair exists, both sides feed
 * it into `@dg-kit/protocol`'s adapters identically, since `createGattShim`
 * synthesizes the same Web-Bluetooth-shaped `BluetoothDeviceLike` (complete
 * with a working `gattserverdisconnected` event and `gatt.disconnect()`).
 *
 * Deliberately does NOT replicate `TauriBlecDeviceClient`'s `autoReconnect`
 * option, matching the Web Bluetooth version's same choice — none of the
 * three aux device kinds need it.
 *
 * Every plugin-blec call this makes is scoped to the address of the device
 * being connected/disconnected, so this can run for several device kinds
 * concurrently (e.g. a Coyote via `TauriBlecDeviceClient` plus an Opossum
 * via `TauriBlecOpossumClient`) without one interfering with another.
 */
import type { BluetoothDeviceLike, WebBluetoothConnectionContext } from '@dg-kit/protocol';
import { createGattShim } from './gatt-shim.js';
import { runWithGattReadyRetry, type GattReadyRetryOptions } from './gatt-ready.js';
import { resolvePluginBlec } from './plugin-blec.js';
import { scanAndSelectDevice, type DeviceSelectionController } from './scan.js';

/** Minimal shape both `OpossumVibrateAdapter` and the sensor adapters satisfy. */
export interface ConnectableAdapter {
  onConnected(context: WebBluetoothConnectionContext): Promise<void>;
  onDisconnected(): Promise<void>;
}

export interface TauriAuxDeviceConnectOptions extends GattReadyRetryOptions {
  /** Called immediately after scan starts; resolves with the picked address or `null` to cancel. */
  selectDevice: (controller: DeviceSelectionController) => Promise<string | null>;
  /** Client-side filter applied to scan results before they reach `selectDevice`. */
  namePrefixes?: string[];
  /** Scan window in milliseconds. Defaults to 8000. */
  scanDurationMs?: number;
}

/**
 * Scans, lets the host UI pick a device, connects it via plugin-blec, and
 * hands the resulting `(device, server)` pair to `adapter.onConnected()`.
 * Mirrors `connectAuxDevice`'s "replace the previous device only after the
 * new one succeeds" ordering: if `onConnected()` throws (a flaky/wrong
 * device picked mid-swap), whatever this client was already connected to
 * stays intact rather than already torn down with nothing to fall back to.
 *
 * Returns the newly connected device; the caller is responsible for storing
 * it and passing it back in on the next call (as `previousDevice`) and to
 * `disconnectTauriAuxDevice`.
 */
export async function connectTauriAuxDevice(
  options: TauriAuxDeviceConnectOptions,
  adapter: ConnectableAdapter,
  previousDevice: BluetoothDeviceLike | null,
  onGattDisconnected: (event: Event) => void,
): Promise<BluetoothDeviceLike> {
  const api = await resolvePluginBlec();

  const granted = await api.checkPermissions(true);
  if (!granted) {
    throw new Error('未授予蓝牙权限');
  }

  const picked = await scanAndSelectDevice(api, {
    selectDevice: options.selectDevice,
    namePrefixes: options.namePrefixes,
    scanDurationMs: options.scanDurationMs,
  });
  if (!picked) {
    throw new Error('用户取消了设备选择');
  }
  const { address, name } = picked;

  let shim: ReturnType<typeof createGattShim> | null = null;
  await api.connect(address, () => {
    shim?.fireDisconnect();
  });
  shim = createGattShim({ address, name, api, onDisconnect: () => undefined });
  const nextDevice = shim.device;
  const server = shim.server;

  const shouldReplacePrevious = !!previousDevice && previousDevice.id !== address;

  if (shouldReplacePrevious) {
    previousDevice!.removeEventListener('gattserverdisconnected', onGattDisconnected);
  }

  try {
    await runWithGattReadyRetry(() => adapter.onConnected({ device: nextDevice, server }), options);
  } catch (error) {
    if (shouldReplacePrevious && isGattConnected(previousDevice)) {
      previousDevice!.addEventListener('gattserverdisconnected', onGattDisconnected);
    }
    if (nextDevice.gatt?.connected) {
      nextDevice.gatt.disconnect();
    } else {
      await api.disconnect(address).catch(() => undefined);
    }
    throw error;
  }

  nextDevice.addEventListener('gattserverdisconnected', onGattDisconnected);

  if (shouldReplacePrevious) {
    disconnectDeviceGatt(previousDevice);
  }

  return nextDevice;
}

/**
 * User-initiated disconnect: removes the listener BEFORE calling
 * `gatt.disconnect()` so the resulting `gattserverdisconnected` event never
 * reaches `onGattDisconnected` a second time.
 */
export async function disconnectTauriAuxDevice(
  device: BluetoothDeviceLike | null,
  adapter: ConnectableAdapter,
  onGattDisconnected: (event: Event) => void,
): Promise<void> {
  if (device) {
    device.removeEventListener('gattserverdisconnected', onGattDisconnected);
    if (device.gatt?.connected) {
      device.gatt.disconnect();
    }
  }
  await adapter.onDisconnected();
}

function isGattConnected(device: BluetoothDeviceLike | null): boolean {
  return !!device?.gatt?.connected;
}

function disconnectDeviceGatt(device: BluetoothDeviceLike | null): void {
  if (!device?.gatt?.connected) return;
  device.gatt.disconnect();
}
