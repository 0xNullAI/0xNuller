/**
 * Single unified cross-kind scan+picker for Tauri Android, the counterpart
 * to `@dg-kit/transport-webbluetooth`'s `requestDgLabDevice()`. Runs ONE
 * plugin-blec scan across every known DG-Lab device kind's name prefix,
 * presents ONE host-supplied picker (`scanAndSelectDevice()` — the same
 * `selectDevice`/`DeviceSelectionController` pattern `TauriBlecDeviceClient`
 * and `connectTauriAuxDevice()` already use), and auto-detects which kind
 * was picked via `detectDeviceKind()` — instead of the caller having to
 * already know the kind before scanning (which is what forced the
 * interim "pick a kind first" flow both DG-Agent's and DG-Chat's Android
 * shells shipped with).
 *
 * Unlike the Web Bluetooth version, kind detection happens BEFORE connecting
 * — plugin-blec's scan already hands back each device's advertised name, so
 * an unrecognized device is rejected without ever dialing plugin-blec's
 * `connect()`, rather than connecting first and disconnecting on a bad kind.
 *
 * Returns `{ kind, device, server }`, mirroring `requestDgLabDevice()`'s
 * return shape as closely as this package's `(device, server)` pair shape
 * (see `createGattShim()`) allows. Route the result to the matching client's
 * `connectDevice(device, server)` passthrough — `TauriBlecDeviceClient` for
 * `coyote`, `TauriBlecOpossumClient` for `opossum`, `TauriBlecPawPrintsClient`
 * / `TauriBlecCivetEdgingClient` (via the shared `TauriBlecSensorClient`
 * base) for `paw-prints` / `civet-edging`.
 */
import {
  CIVET_DEVICE_NAME_PREFIX,
  OPOSSUM_DEVICE_NAME_PREFIX,
  PAW_PRINTS_DEVICE_NAME_PREFIX,
  V2_DEVICE_NAME_PREFIX,
  V3_DEVICE_NAME_PREFIX,
  detectDeviceKind,
  type RequestedDevice,
} from '@dg-kit/protocol';
import { createGattShim } from './gatt-shim.js';
import { resolvePluginBlec } from './plugin-blec.js';
import { prewarmDeviceScan, scanAndSelectDevice, type DeviceSelectionController } from './scan.js';
import { DEVICE_PICKER_CANCELLED_MESSAGE } from '@dg-kit/core';

/**
 * Combined name-prefix filter covering every known DG-Lab device kind —
 * the plugin-blec scan counterpart to `@dg-kit/protocol`'s
 * `DG_LAB_REQUEST_DEVICE_OPTIONS` (which scopes the Web Bluetooth chooser
 * to the same set via `filters`).
 */
export const DG_LAB_TAURI_NAME_PREFIXES: string[] = [
  V3_DEVICE_NAME_PREFIX,
  PAW_PRINTS_DEVICE_NAME_PREFIX,
  CIVET_DEVICE_NAME_PREFIX,
  OPOSSUM_DEVICE_NAME_PREFIX,
  V2_DEVICE_NAME_PREFIX,
];

/** Start a permission-silent all-kind scan for the Android shell cache. */
export async function prewarmDgLabDeviceScan(scanDurationMs = 8000): Promise<void> {
  const api = await resolvePluginBlec();
  await prewarmDeviceScan(api, {
    namePrefixes: DG_LAB_TAURI_NAME_PREFIXES,
    scanDurationMs,
  });
}

export interface RequestDgLabDeviceTauriOptions {
  /**
   * Called immediately after scan starts. The host UI opens the device
   * picker and subscribes to live updates via the controller. Resolves with
   * the chosen device address, or `null` if the user cancels.
   */
  selectDevice: (controller: DeviceSelectionController) => Promise<string | null>;
  /**
   * Overrides the combined all-kind scan filter — mainly for tests. Default:
   * `DG_LAB_TAURI_NAME_PREFIXES`.
   */
  namePrefixes?: string[];
  /** Scan window in milliseconds. Defaults to 8000. */
  scanDurationMs?: number;
}

/** @see RequestedDevice — the shared shape every cross-kind picker returns. */
export type RequestedDgLabDeviceTauri = RequestedDevice;

const GAP_SERVICE_UUID = '00001800-0000-1000-8000-00805f9b34fb';
const GAP_DEVICE_NAME_UUID = '00002a00-0000-1000-8000-00805f9b34fb';
const COYOTE_V3_IDENTIFYING_SERVICES = [
  '00002003-0000-1000-8000-00805f9b34fb',
  '00002004-0000-1000-8000-00805f9b34fb',
] as const;

/**
 * Identifies the nameless Coyote V3 hardware seen on Android by its complete
 * service fingerprint. The generic 0x180c service is shared by other DG-Lab
 * devices, so it must never be enough on its own to guess a device kind.
 */
export function detectAnonymousDgLabKind(services: string[]): ReturnType<typeof detectDeviceKind> {
  const normalized = new Set(services.map((uuid) => uuid.toLowerCase()));
  return COYOTE_V3_IDENTIFYING_SERVICES.every((uuid) => normalized.has(uuid))
    ? 'coyote'
    : 'unknown';
}

async function readGattDeviceName(
  api: Awaited<ReturnType<typeof resolvePluginBlec>>,
  address: string,
): Promise<string> {
  try {
    const bytes = await api.read(GAP_DEVICE_NAME_UUID, GAP_SERVICE_UUID, address);
    return new TextDecoder().decode(Uint8Array.from(bytes)).replace(/\0+$/g, '').trim();
  } catch {
    return '';
  }
}

/**
 * Opens ONE plugin-blec scan scoped to every known DG-Lab device kind,
 * lets the host UI pick a device, connects it, and identifies which kind
 * was picked via `detectDeviceKind()`.
 *
 * Rejects (without ever calling `api.connect()`) on an unrecognized device
 * name — the scan filter already scopes results to DG-Lab prefixes, so this
 * should only trigger if a device happens to advertise a matching prefix
 * without actually being a DG-Lab device.
 */
export async function requestDgLabDeviceTauri(
  options: RequestDgLabDeviceTauriOptions,
): Promise<RequestedDgLabDeviceTauri> {
  const api = await resolvePluginBlec();

  const granted = await api.checkPermissions(true);
  if (!granted) {
    throw new Error('未授予蓝牙权限');
  }

  const picked = await scanAndSelectDevice(api, {
    selectDevice: options.selectDevice,
    namePrefixes: options.namePrefixes ?? DG_LAB_TAURI_NAME_PREFIXES,
    scanDurationMs: options.scanDurationMs,
  });
  if (!picked) {
    throw new Error(DEVICE_PICKER_CANCELLED_MESSAGE);
  }
  const { address, name, services } = picked;
  if (name.trim() && detectDeviceKind(name) === 'unknown') {
    throw new Error('未识别的设备，请确认选择了正确的 DG-Lab 设备');
  }

  let shim: ReturnType<typeof createGattShim> | null = null;
  if (/Android/i.test(globalThis.navigator?.userAgent ?? '')) {
    await api.setAndroidMtu?.(144).catch(() => undefined);
  }
  await api.connect(address, () => {
    shim?.fireDisconnect();
  });
  // Android 11/MIUI sometimes omits the GAP name from advertisements and only
  // exposes it after GATT connects. Refresh before classifying the device.
  const connected = await api.connectedDevices().catch(() => []);
  const refreshedName = connected.find((device) => device.address === address)?.name?.trim();
  const gattName = await readGattDeviceName(api, address);
  const resolvedName =
    [name.trim(), refreshedName, gattName].find(
      (candidate) => candidate && detectDeviceKind(candidate) !== 'unknown',
    ) ?? '';
  const kind = resolvedName ? detectDeviceKind(resolvedName) : detectAnonymousDgLabKind(services);
  if (kind === 'unknown') {
    await api.disconnect(address).catch(() => undefined);
    throw new Error('已连接到设备，但无法识别型号；请选择名称为 47L12x 或 D-LAB ESTIM 的设备');
  }
  // Protocol adapters still classify the BluetoothDevice facade by its
  // canonical advertised prefix. Preserve that invariant internally even
  // when Android omitted the local name; product UI renders the device kind
  // label separately and does not expose this compatibility fallback.
  const deviceName =
    resolvedName || (kind === 'coyote' ? `${V3_DEVICE_NAME_PREFIX}-Android` : 'DG-Lab');
  shim = createGattShim({ address, name: deviceName, api, onDisconnect: () => undefined });

  return { kind, device: shim.device, server: shim.server };
}
