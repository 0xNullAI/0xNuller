import type { DeviceClient, DeviceCommand, DeviceCommandResult, DeviceState } from '@dg-kit/core';
import type { WebBluetoothProtocolAdapter } from '@dg-kit/protocol';
import { createGattShim } from './gatt-shim.js';
import { resolvePluginBlec, type BleDeviceInfo } from './plugin-blec.js';

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

export interface TauriBlecDeviceClientOptions {
  protocol: WebBluetoothProtocolAdapter;
  /**
   * Called immediately after scan starts. The host UI opens the device picker
   * and subscribes to live updates via the controller. Resolves with the
   * chosen device address, or `null` if the user cancels.
   */
  selectDevice: (controller: DeviceSelectionController) => Promise<string | null>;
  /**
   * Optional client-side filter applied to scan results before they reach
   * `selectDevice`. Coyote V2 names start with `D-LAB ESTIM01`; V3 with `47L121`.
   * Default: no filter (caller must filter or DevicePicker shows all).
   */
  namePrefixes?: string[];
  /** Scan window in milliseconds. Defaults to 8000. */
  scanDurationMs?: number;
  /**
   * Grace period after `plugin-blec.connect()` resolves, before the first
   * `protocol.onConnected()` attempt. Android's `BluetoothGatt` service
   * discovery is async and may not be visible to plugin-blec the instant
   * `connect()` returns; the first `send`/`subscribe` then fails with
   * "No services matching UUID". Defaults to 300ms.
   */
  gattReadyInitialDelayMs?: number;
  /**
   * Total budget for retrying `protocol.onConnected()` when it fails with
   * a service/characteristic-not-found error. Defaults to 3000ms.
   */
  gattReadyTimeoutMs?: number;
  /** Delay between retry attempts. Defaults to 250ms. */
  gattReadyIntervalMs?: number;
  /**
   * Substrings (case-insensitive) that identify a transient
   * GATT-not-ready error from plugin-blec / btleplug. Override only if
   * the underlying transport surfaces a non-default message. Defaults
   * cover known wording: "no services matching", "service not found",
   * "characteristic not found", "no such characteristic", "not connected".
   */
  gattReadyErrorPatterns?: string[];
}

const DEFAULT_GATT_READY_INITIAL_DELAY_MS = 300;
const DEFAULT_GATT_READY_TIMEOUT_MS = 3000;
const DEFAULT_GATT_READY_INTERVAL_MS = 250;
const DEFAULT_GATT_READY_ERROR_PATTERNS = [
  'no services matching',
  'service not found',
  'no such service',
  'characteristic not found',
  'no such characteristic',
  'not connected',
];

export class TauriBlecDeviceClient implements DeviceClient {
  private readonly listeners = new Set<(state: DeviceState) => void>();
  private connected = false;
  private connecting = false;
  private fireDisconnect: (() => void) | null = null;

  constructor(private readonly options: TauriBlecDeviceClientOptions) {
    this.options.protocol.subscribe((state) => {
      for (const l of this.listeners) l(state);
    });
  }

  async connect(): Promise<void> {
    // Reentrancy guard: double-tap on the connect button must not start
    // two parallel scans or two plugin-blec.connect() calls. plugin-blec
    // holds a single active peripheral internally, so concurrent calls
    // produce undefined behaviour (two device pickers, ghost subscribers,
    // mismatched onDisconnect callbacks).
    if (this.connected) {
      throw new Error('设备已连接');
    }
    if (this.connecting) {
      throw new Error('正在连接中，请稍候');
    }
    this.connecting = true;
    try {
      await this.connectInner();
    } finally {
      this.connecting = false;
    }
  }

  private async connectInner(): Promise<void> {
    const api = await resolvePluginBlec();

    const granted = await api.checkPermissions(true);
    if (!granted) {
      throw new Error('未授予蓝牙权限');
    }

    const seen = new Map<string, BleDeviceInfo>();
    const scanDuration = this.options.scanDurationMs ?? 8000;
    const prefixes = this.options.namePrefixes;
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
      address = await this.options.selectDevice({
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

    if (!address) {
      throw new Error('用户取消了设备选择');
    }

    const chosen = seen.get(address);
    const deviceName = chosen?.name ?? '';

    let shim: ReturnType<typeof createGattShim> | null = null;
    await api.connect(address, () => {
      this.connected = false;
      shim?.fireDisconnect();
      void this.options.protocol.onDisconnected();
    });

    shim = createGattShim({
      address,
      name: deviceName,
      api,
      onDisconnect: () => undefined,
    });
    this.fireDisconnect = shim.fireDisconnect;

    try {
      await this.runWithGattReadyRetry(() =>
        this.options.protocol.onConnected({
          device: shim!.device,
          server: shim!.server,
        }),
      );
      this.connected = true;
    } catch (error) {
      await api.disconnect().catch(() => undefined);
      throw error;
    }
  }

  /**
   * Drive `protocol.onConnected()` through Android's async GATT discovery.
   *
   * plugin-blec's `connect()` resolves before `BluetoothGatt.discoverServices`
   * is guaranteed visible. The first send/subscribe inside `onConnected()`
   * then fails with "No services matching UUID". `protocol.onConnected()`
   * resets its own state on failure, so retrying it is safe.
   */
  private async runWithGattReadyRetry(attempt: () => Promise<void>): Promise<void> {
    const opts = this.options;
    const initialDelay = opts.gattReadyInitialDelayMs ?? DEFAULT_GATT_READY_INITIAL_DELAY_MS;
    const totalTimeout = opts.gattReadyTimeoutMs ?? DEFAULT_GATT_READY_TIMEOUT_MS;
    const interval = opts.gattReadyIntervalMs ?? DEFAULT_GATT_READY_INTERVAL_MS;
    const patterns = opts.gattReadyErrorPatterns ?? DEFAULT_GATT_READY_ERROR_PATTERNS;

    if (initialDelay > 0) await delay(initialDelay);

    const deadline = Date.now() + Math.max(0, totalTimeout);
    let lastError: unknown;
    // First try after the grace delay; if it works, we're done with one pass.
    while (true) {
      try {
        await attempt();
        return;
      } catch (error) {
        lastError = error;
        if (!isGattNotReadyError(error, patterns)) throw error;
        if (Date.now() >= deadline) break;
        await delay(interval);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('GATT 服务发现超时，请重新连接');
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    // Mirror transport-webbluetooth: zero the device before tearing down
    // BLE so a user-initiated disconnect never leaves the Coyote running
    // at its last commanded strength (V3 is state-retentive across drops).
    await this.options.protocol.emergencyStop().catch(() => undefined);
    const api = await resolvePluginBlec();
    await api.disconnect().catch(() => undefined);
    this.connected = false;
    this.fireDisconnect?.();
    this.fireDisconnect = null;
    await this.options.protocol.onDisconnected();
  }

  async execute(command: DeviceCommand): Promise<DeviceCommandResult> {
    return this.options.protocol.execute(command);
  }

  async emergencyStop(): Promise<void> {
    await this.options.protocol.emergencyStop();
  }

  async getState(): Promise<DeviceState> {
    return this.options.protocol.getState();
  }

  onStateChanged(listener: (state: DeviceState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

function isGattNotReadyError(error: unknown, patterns: string[]): boolean {
  const msg =
    error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);
  const lower = msg.toLowerCase();
  return patterns.some((p) => lower.includes(p.toLowerCase()));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
