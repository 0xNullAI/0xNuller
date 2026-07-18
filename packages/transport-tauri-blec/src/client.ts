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

export type ReconnectState = 'reconnecting' | 'reconnected' | 'failed';

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
  /**
   * When true, an unexpected disconnect signalled by plugin-blec (device
   * out of range, OS killed the link, etc.) triggers a silent reconnect
   * using the last-connected device's address — no new scan / selectDevice
   * prompt. A user-initiated `disconnect()` call always cancels any
   * pending or in-flight reconnect and is never followed by one, even if
   * plugin-blec's own disconnect signal arrives afterward. Defaults to
   * false (opt-in), mirroring `transport-webbluetooth`.
   */
  autoReconnect?: boolean;
  /** Maximum reconnect attempts before giving up. Defaults to 3. */
  reconnectAttempts?: number;
  /**
   * Delay (ms) before each reconnect attempt. Index N is used for the
   * (N+1)-th attempt. If fewer entries than attempts, the last entry is
   * reused. Defaults to [500, 1500, 4000].
   */
  reconnectBackoffMs?: number[];
  /** Notified when entering/leaving the reconnecting state. */
  onReconnectStateChange?: (state: ReconnectState) => void;
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
const DEFAULT_RECONNECT_ATTEMPTS = 3;
const DEFAULT_RECONNECT_BACKOFF_MS = [500, 1500, 4000];

export class TauriBlecDeviceClient implements DeviceClient {
  private readonly listeners = new Set<(state: DeviceState) => void>();
  private connected = false;
  private connecting = false;
  private disconnecting = false;
  private fireDisconnect: (() => void) | null = null;
  /** Address/name of the last successful connection, kept only for auto-reconnect. */
  private lastAddress: string | null = null;
  private lastDeviceName = '';
  private reconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

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
    // mismatched onDisconnect callbacks). A reconnect attempt sets
    // `connecting` for the same reason while it's actually inside
    // plugin-blec.connect(), so this guard also rejects a manual connect()
    // that lands mid-attempt instead of racing it.
    if (this.connected) {
      throw new Error('设备已连接');
    }
    if (this.connecting) {
      throw new Error('正在连接中，请稍候');
    }
    // A user tapping "connect" explicitly takes over from any passive
    // auto-reconnect scheduled for the previous address.
    this.cancelReconnect();
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

    await this.establishConnection(address, deviceName);
  }

  /**
   * Drives plugin-blec's connect flow plus the GATT-ready retry for a known
   * device address. Shared by the initial `connect()` (after scan +
   * selectDevice) and by `tryReconnect()` (which skips straight here with
   * the last-connected address — no new scan / chooser prompt).
   */
  private async establishConnection(address: string, name: string): Promise<void> {
    const api = await resolvePluginBlec();

    let shim: ReturnType<typeof createGattShim> | null = null;
    await api.connect(address, () => {
      this.connected = false;
      shim?.fireDisconnect();
      this.handlePluginDisconnectSignal();
    });

    shim = createGattShim({
      address,
      name,
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
      this.lastAddress = address;
      this.lastDeviceName = name;
    } catch (error) {
      await api.disconnect().catch(() => undefined);
      throw error;
    }
  }

  /**
   * Runs after plugin-blec signals a disconnect (device out of range, OS
   * killed the link, or a user-initiated teardown plugin-blec happened to
   * echo back). Always tells the protocol layer we've dropped; only
   * schedules a reconnect when the drop wasn't caused by our own
   * `disconnect()` and the caller opted in.
   */
  private handlePluginDisconnectSignal(): void {
    void this.options.protocol.onDisconnected();

    if (this.disconnecting) return;
    if (this.reconnecting) return;
    if (!this.options.autoReconnect || !this.lastAddress) return;

    this.scheduleReconnect(1);
  }

  private scheduleReconnect(attempt: number): void {
    const maxAttempts = this.options.reconnectAttempts ?? DEFAULT_RECONNECT_ATTEMPTS;
    if (attempt > maxAttempts) {
      this.reconnecting = false;
      this.options.onReconnectStateChange?.('failed');
      this.lastAddress = null;
      return;
    }

    this.reconnecting = true;
    this.options.onReconnectStateChange?.('reconnecting');

    const backoff = this.options.reconnectBackoffMs ?? DEFAULT_RECONNECT_BACKOFF_MS;
    // Reuse the last entry when attempts outrun the backoff schedule.
    const delayMs = backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 0;

    this.reconnectTimer = setTimeout(() => {
      void this.tryReconnect(attempt);
    }, delayMs);
  }

  private async tryReconnect(attempt: number): Promise<void> {
    this.reconnectTimer = null;
    if (this.disconnecting) {
      this.reconnecting = false;
      this.disconnecting = false;
      return;
    }

    const address = this.lastAddress;
    if (!address) {
      this.reconnecting = false;
      this.options.onReconnectStateChange?.('failed');
      return;
    }

    // Reuse the manual-connect reentrancy guard for the duration of the
    // actual attempt, so a `connect()` call that lands mid-attempt is
    // rejected instead of racing this call into plugin-blec.connect().
    this.connecting = true;
    try {
      await this.establishConnection(address, this.lastDeviceName);
    } catch {
      this.connecting = false;
      this.reconnecting = false;
      if (this.disconnecting) {
        // disconnect() ran while this attempt was in flight and deliberately
        // left `disconnecting` set for us to consume (see disconnect()) —
        // the attempt failed anyway, so there's nothing to tear down, just
        // stop retrying.
        this.disconnecting = false;
        return;
      }
      this.scheduleReconnect(attempt + 1);
      return;
    }
    this.connecting = false;

    if (this.disconnecting) {
      // disconnect() ran while this attempt was in flight (it can't cancel
      // an already-started plugin-blec.connect() call, only a pending
      // timer) — tear the freshly-established link back down instead of
      // leaving it alive behind the protocol layer's back. disconnect()
      // deliberately left `disconnecting` set for us to consume here; clear
      // it now that we have.
      this.reconnecting = false;
      this.disconnecting = false;
      await this.forceTeardown();
      return;
    }

    this.reconnecting = false;
    this.options.onReconnectStateChange?.('reconnected');
  }

  private async forceTeardown(): Promise<void> {
    // Reached when disconnect() was called while a reconnect attempt was
    // actively re-establishing the link, and that attempt then succeeded —
    // the freshly-reconnected device needs the exact same "zero it before
    // tearing down BLE" treatment disconnect()'s own `if (this.connected)`
    // branch gives a normal disconnect (V3 is state-retentive across BLE
    // drops), otherwise a user who disconnected mid-reconnect could be left
    // with the device still running at its last commanded strength and no
    // way to remotely stop it until reconnecting again.
    await this.options.protocol.emergencyStop().catch(() => undefined);
    this.connected = false;
    this.lastAddress = null;
    this.fireDisconnect?.();
    this.fireDisconnect = null;
    const api = await resolvePluginBlec();
    await api.disconnect().catch(() => undefined);
    await this.options.protocol.onDisconnected().catch(() => undefined);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnecting = false;
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
    // A reconnect attempt may be scheduled or actively in flight even while
    // `connected` is false (it flips true only once establishConnection
    // succeeds) — still run the teardown machinery below so we cancel it.
    const hadReconnectPending = this.reconnecting;
    if (!this.connected && !hadReconnectPending) return;

    this.disconnecting = true;
    this.cancelReconnect();
    // Forget the last-connected address unconditionally: this is what
    // `handlePluginDisconnectSignal` checks, so it also guards against a
    // stray plugin-blec disconnect callback landing after this method
    // returns (and `disconnecting` has been reset) from re-triggering
    // auto-reconnect.
    this.lastAddress = null;
    try {
      if (this.connected) {
        // Mirror transport-webbluetooth: zero the device before tearing
        // down BLE so a user-initiated disconnect never leaves the Coyote
        // running at its last commanded strength (V3 is state-retentive
        // across drops).
        await this.options.protocol.emergencyStop().catch(() => undefined);
        const api = await resolvePluginBlec();
        await api.disconnect().catch(() => undefined);
        this.connected = false;
        this.fireDisconnect?.();
        this.fireDisconnect = null;
        await this.options.protocol.onDisconnected();
      }
    } finally {
      // If a reconnect attempt is actively inside establishConnection right
      // now (this.connecting), leave `disconnecting` set: this method has
      // nothing left to await in that case (the `if (this.connected)` branch
      // above is skipped, since establishConnection hasn't flipped
      // `connected` true yet), so resetting it here would race the
      // in-flight attempt's own check of the flag once plugin-blec.connect()
      // resolves — it would see `disconnecting === false` and wrongly
      // report 'reconnected'. tryReconnect() clears it once it has consumed
      // the signal (see its `disconnecting` branches).
      if (!this.connecting) {
        this.disconnecting = false;
      }
    }
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
