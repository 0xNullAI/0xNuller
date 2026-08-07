import type { BleDeviceInfo, PluginBlecApi } from './plugin-blec.js';

export interface DiscoveredDevice {
  address: string;
  name: string;
  rssi: number;
  isConnected: boolean;
  services: string[];
}

/**
 * Live controller passed to `selectDevice`. The picker UI subscribes for
 * incremental device updates while the scan is still in progress.
 */
export interface DeviceSelectionController {
  /** Snapshot of devices already discovered when the picker opens. */
  initial: DiscoveredDevice[];
  /**
   * Receive each subsequent batch of discovered devices. Returns an
   * unsubscribe function the picker should call before resolving.
   */
  subscribe(handler: (devices: DiscoveredDevice[]) => void): () => void;
}

export interface ScanAndSelectOptions {
  /**
   * Called immediately after scan starts. The host UI opens the device
   * picker and subscribes to live updates via the controller. Resolves with
   * the chosen device address, or `null` if the user cancels.
   */
  selectDevice: (controller: DeviceSelectionController) => Promise<string | null>;
  /**
   * Optional client-side filter applied to scan results before they reach
   * `selectDevice`. Default: no filter (caller must filter or the picker
   * shows all discovered devices).
   */
  namePrefixes?: string[];
  /** Scan window in milliseconds. Defaults to 8000. */
  scanDurationMs?: number;
}

/**
 * Shared scan → live device picker flow, used by `TauriBlecDeviceClient`
 * (Coyote) and `connectTauriAuxDevice` (Opossum/sensor clients) alike, so
 * the scanning/picker-wiring logic isn't duplicated per device kind.
 *
 * Returns the picked device's address/name, or `null` if the user cancelled
 * (`selectDevice` resolved with `null`).
 */
export async function scanAndSelectDevice(
  api: PluginBlecApi,
  options: ScanAndSelectOptions,
): Promise<{ address: string; name: string } | null> {
  const seen = new Map<string, BleDeviceInfo>();
  const scanDuration = options.scanDurationMs ?? 8000;
  const prefixes = options.namePrefixes;
  const updateListeners = new Set<(devices: DiscoveredDevice[]) => void>();

  const toDiscovered = (): DiscoveredDevice[] =>
    [...seen.values()].map((d) => ({
      address: d.address,
      name: d.name,
      rssi: d.rssi,
      isConnected: d.isConnected,
      services: d.services,
    }));

  // Kick off the scan; handler appends devices and notifies listeners.
  const scanPromise = api.startScan((devices) => {
    let changed = false;
    for (const d of devices) {
      if (prefixes && !prefixes.some((p) => d.name.startsWith(p))) continue;
      const prev = seen.get(d.address);
      if (!prev || hasMaterialChange(prev, d)) changed = true;
      seen.set(d.address, d);
    }
    if (changed) {
      const snapshot = toDiscovered();
      for (const fn of updateListeners) fn(snapshot);
    }
  }, scanDuration);

  let address: string | null;
  try {
    address = await options.selectDevice({
      get initial() {
        return toDiscovered();
      },
      subscribe(handler) {
        updateListeners.add(handler);
        return () => {
          updateListeners.delete(handler);
        };
      },
    });
  } finally {
    // Always stop the scan once the user has chosen / cancelled.
    await scanPromise.catch(() => undefined);
    await api.stopScan().catch(() => undefined);
  }

  if (!address) return null;

  const chosen = seen.get(address);
  return { address, name: chosen?.name ?? '' };
}

function hasMaterialChange(prev: BleDeviceInfo, next: BleDeviceInfo): boolean {
  if (prev.rssi !== next.rssi) return true;
  if (prev.isConnected !== next.isConnected) return true;
  if (prev.name !== next.name) return true;
  if (prev.services.length !== next.services.length) return true;
  for (let i = 0; i < prev.services.length; i += 1) {
    if (prev.services[i] !== next.services[i]) return true;
  }
  return false;
}
