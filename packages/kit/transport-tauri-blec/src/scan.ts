import type { BleDeviceInfo, PluginBlecApi } from './plugin-blec.js';
import { DgScannerLease } from './scanner-coordination.js';

const PREWARM_CACHE_TTL_MS = 30_000;
const prewarmedDevices = new Map<string, { device: BleDeviceInfo; seenAt: number }>();

interface CancellableScanWindow {
  done: Promise<boolean>;
  cancel(): void;
}

interface ActivePrewarmScan {
  api: PluginBlecApi;
  lease: DgScannerLease;
  window: CancellableScanWindow;
  done: Promise<void>;
}

let prewarmScan: ActivePrewarmScan | null = null;

function createScanWindow(durationMs: number): CancellableScanWindow {
  let finish: ((elapsed: boolean) => void) | null = null;
  const done = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  const timer = setTimeout(() => {
    finish?.(true);
    finish = null;
  }, durationMs);
  return {
    done,
    cancel() {
      if (!finish) return;
      clearTimeout(timer);
      finish(false);
      finish = null;
    },
  };
}

export interface DiscoveredDevice {
  address: string;
  name: string;
  rssi: number;
  isConnected: boolean;
  services: string[];
}

/**
 * Official DG-Lab Android fallback for devices whose AD 0x09 local name is
 * absent: accept AD 0xFF manufacturer payloads whose complete value is 8-16
 * bytes. Android exposes the two-byte company identifier as the map key, so
 * each value here is valid when it contributes another 6-14 bytes.
 */
export function hasOfficialDgLabManufacturerFallback(device: BleDeviceInfo): boolean {
  return Object.values(device.manufacturerData ?? {}).some((payload) => {
    const completeLength = 2 + payload.length;
    return completeLength >= 8 && completeLength <= 16;
  });
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
  /** Whether the timed BLE scan is still running. */
  readonly scanning: boolean;
  /** Receive scan-state changes, including the transition to completed. */
  subscribeScanning(handler: (scanning: boolean) => void): () => void;
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

export interface PrewarmScanOptions {
  namePrefixes?: string[];
  scanDurationMs?: number;
}

/**
 * Quietly collect named DG-Lab advertisements while the Android shell starts.
 * Permission is checked without prompting; the normal connect action remains
 * responsible for explaining and requesting missing platform permission.
 */
export async function prewarmDeviceScan(
  api: PluginBlecApi,
  options: PrewarmScanOptions = {},
): Promise<void> {
  if (prewarmScan) return;
  if (!(await api.checkPermissions(false))) return;

  const prefixes = options.namePrefixes;
  const duration = options.scanDurationMs ?? 8000;
  const lease = await DgScannerLease.claim();
  try {
    await api.startScan((devices) => {
      const seenAt = Date.now();
      for (const device of devices) {
        const name = device.name.trim();
        if (!name || (prefixes && !prefixes.some((prefix) => name.startsWith(prefix)))) continue;
        prewarmedDevices.set(device.address, { device, seenAt });
      }
    }, duration);
  } catch (error) {
    await lease.cleanup(() => api.stopScan());
    throw error;
  }

  const window = createScanWindow(duration);
  let active: ActivePrewarmScan | null = null;
  const done = window.done
    .then(() => lease.cleanup(() => api.stopScan()))
    .finally(() => {
      if (prewarmScan === active && lease.isReleased) prewarmScan = null;
    });
  active = { api, lease, window, done };
  prewarmScan = active;
  void done.catch(() => undefined);
}

async function stopPrewarmScan(): Promise<void> {
  const active = prewarmScan;
  if (!active) return;
  active.window.cancel();
  await active.done;
  if (prewarmScan === active && active.lease.isReleased) prewarmScan = null;
}

function freshPrewarmedDevices(now = Date.now()): BleDeviceInfo[] {
  const fresh: BleDeviceInfo[] = [];
  for (const [address, cached] of prewarmedDevices) {
    if (now - cached.seenAt > PREWARM_CACHE_TTL_MS) {
      prewarmedDevices.delete(address);
    } else {
      fresh.push(cached.device);
    }
  }
  return fresh;
}

export function __resetPrewarmScanForTests(): void {
  prewarmedDevices.clear();
  prewarmScan?.window.cancel();
  prewarmScan = null;
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
): Promise<{ address: string; name: string; services: string[] } | null> {
  const seen = new Map<string, BleDeviceInfo>();
  const anonymousCandidates = new Map<string, BleDeviceInfo>();
  const discoveryOrder = new Map<string, number>();
  let nextDiscoveryOrder = 0;
  let orderFrozen = false;
  const scanDuration = options.scanDurationMs ?? 8000;
  const prefixes = options.namePrefixes;
  const updateListeners = new Set<(devices: DiscoveredDevice[]) => void>();
  const scanningListeners = new Set<(scanning: boolean) => void>();
  let scanning = true;
  let selectionFinished = false;
  const verification = { inFlight: null as Promise<void> | null };

  // A startup scan may still own Android's single scanner callback. Stop it
  // before replacing the callback, then seed the picker with its fresh named
  // results so a common reconnect does not pay another discovery delay.
  await stopPrewarmScan();
  for (const device of freshPrewarmedDevices()) {
    const name = device.name.trim();
    if (prefixes && !prefixes.some((prefix) => name.startsWith(prefix))) continue;
    seen.set(device.address, device);
  }

  const toDiscovered = (): DiscoveredDevice[] =>
    [...seen.values()]
      // Never reorder visible rows while a user is about to tap one. RSSI
      // changes many times per second; sorting every update can move another
      // address under the finger between pointer-down and click.
      .sort(
        (a, b) =>
          (discoveryOrder.get(a.address) ?? Number.MAX_SAFE_INTEGER) -
          (discoveryOrder.get(b.address) ?? Number.MAX_SAFE_INTEGER),
      )
      .map((d) => ({
        address: d.address,
        name: d.name,
        rssi: d.rssi,
        isConnected: d.isConnected,
        services: d.services,
      }));

  // Native ownership is claimed before plugin-blec can register Android's
  // single scanner callback. A competing backend (or a parallel DG scan)
  // therefore fails before touching the radio.
  const lease = await DgScannerLease.claim();
  try {
    await api.startScan((devices) => {
      let changed = false;
      for (const d of devices) {
        // Match the official Android scanner: prefer AD 0x09 names, but retain
        // its AD 0xFF length fallback for nameless devices. A selected anonymous
        // candidate is still verified after GATT connect before it is exposed as
        // a usable device.
        const name = d.name.trim();
        const supportedName = Boolean(
          name && (!prefixes || prefixes.some((prefix) => name.startsWith(prefix))),
        );
        const supportedAnonymous = !name && hasOfficialDgLabManufacturerFallback(d);
        if (!supportedName && !supportedAnonymous) {
          continue;
        }
        // The official app accepts this manufacturer-length fallback as a
        // candidate, but treating it as a confirmed identity makes unrelated
        // beacons appear as DG-Lab devices. Keep anonymous candidates hidden
        // until their GATT services prove they are part of the supported family.
        if (supportedAnonymous && !supportedName) {
          anonymousCandidates.set(d.address, d);
          continue;
        }
        if (orderFrozen && !discoveryOrder.has(d.address)) {
          discoveryOrder.set(d.address, nextDiscoveryOrder++);
        }
        const prev = seen.get(d.address);
        if (!prev || hasMaterialChange(prev, d)) changed = true;
        seen.set(d.address, d);
      }
      if (changed) {
        const snapshot = toDiscovered();
        for (const fn of updateListeners) fn(snapshot);
      }
    }, scanDuration);
  } catch (error) {
    // A rejected start can still leave platform scanner state uncertain.
    // Confirm stop before releasing; a failed stop intentionally keeps the
    // native claim held so Buttplug continues to fail closed.
    await lease.cleanup(() => api.stopScan());
    throw error;
  }
  const verifyAnonymousCandidates = async () => {
    const candidates = [...anonymousCandidates.values()]
      .sort((a, b) => b.rssi - a.rssi)
      .slice(0, 8);
    // Android BLE stacks are especially prone to GATT 133 when temporary
    // verification connections overlap. Probe strictly one at a time and
    // stop as soon as the picker resolves so verification never competes with
    // the real connection the user just requested.
    for (const candidate of candidates) {
      if (selectionFinished) break;
      try {
        const services = await api.listServices(candidate.address);
        if (selectionFinished) break;
        if (!hasSupportedDgLabGatt(services.map((service) => service.uuid))) continue;
        seen.set(candidate.address, {
          ...candidate,
          services: services.map((service) => service.uuid),
        });
        if (!discoveryOrder.has(candidate.address)) {
          discoveryOrder.set(candidate.address, nextDiscoveryOrder++);
        }
        const snapshot = toDiscovered();
        for (const fn of updateListeners) fn(snapshot);
      } catch {
        // A failed/foreign candidate remains hidden. listServices performs
        // its own temporary disconnect on successful probes.
      }
    }
  };
  // plugin-blec's `startScan()` resolves when the native scan has STARTED,
  // not when its timeout has elapsed. A cancellable window avoids a delayed
  // stop from an early picker choice tearing down a newer backend's scan.
  const scanWindow = createScanWindow(scanDuration);
  const scanCompletion = scanWindow.done
    .then((elapsed) =>
      lease.cleanup(
        () => api.stopScan(),
        elapsed && !selectionFinished
          ? async () => {
              verification.inFlight = verifyAnonymousCandidates();
              await verification.inFlight;
            }
          : undefined,
      ),
    )
    .then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    .finally(() => {
      scanning = false;
      for (const fn of scanningListeners) fn(false);
    });

  let address: string | null = null;
  let selectionFailed = false;
  let selectionError: unknown;
  try {
    // A mocked or already-completed scan may resolve synchronously. Give its
    // post-scan GATT verification a chance to publish before taking the
    // initial picker snapshot; real radio scans remain live for their normal
    // timeout and are unaffected.
    await Promise.resolve();
    await Promise.resolve();
    // Let Android collect an initial radio snapshot, rank that snapshot once,
    // then freeze row order. This keeps the strongest candidates visible
    // without letting live RSSI changes move a different device under a tap.
    if (seen.size === 0 && /Android/i.test(globalThis.navigator?.userAgent ?? '')) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(900, scanDuration)));
    }
    for (const device of [...seen.values()].sort((a, b) => b.rssi - a.rssi)) {
      discoveryOrder.set(device.address, nextDiscoveryOrder++);
    }
    orderFrozen = true;
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
      get scanning() {
        return scanning;
      },
      subscribeScanning(handler) {
        scanningListeners.add(handler);
        return () => {
          scanningListeners.delete(handler);
        };
      },
    });
  } catch (error) {
    selectionFailed = true;
    selectionError = error;
  }

  // A named device can be selected before the timed scan ends. Cancel the
  // timer, then wait for confirmed stop, any in-flight GATT verification,
  // and native ownership release before connecting or reporting cancel.
  selectionFinished = true;
  scanWindow.cancel();
  const completion = await scanCompletion;
  if (!completion.ok) throw completion.error;
  if (selectionFailed) throw selectionError;
  if (!address) return null;

  const chosen = seen.get(address);
  return { address, name: chosen?.name ?? '', services: chosen?.services ?? [] };
}

const SUPPORTED_DG_LAB_GATT_SERVICES = new Set([
  '0000180c-0000-1000-8000-00805f9b34fb',
  '0000ff0a-0000-1000-8000-00805f9b34fb',
  '955a180b-0fe2-f5aa-a094-84b8d4f3e8ad',
]);

export function hasSupportedDgLabGatt(services: readonly string[]): boolean {
  return services.some((uuid) => SUPPORTED_DG_LAB_GATT_SERVICES.has(uuid.toLowerCase()));
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
