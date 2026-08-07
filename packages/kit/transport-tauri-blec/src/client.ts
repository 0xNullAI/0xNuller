import type { DeviceClient, DeviceCommand, DeviceCommandResult, DeviceState } from '@dg-kit/core';
import type {
  BluetoothDeviceLike,
  BluetoothRemoteGATTServerLike,
  WebBluetoothProtocolAdapter,
} from '@dg-kit/protocol';
import { createGattShim } from './gatt-shim.js';
import { runWithGattReadyRetry, type GattReadyRetryOptions } from './gatt-ready.js';
import { resolvePluginBlec } from './plugin-blec.js';
import { scanAndSelectDevice, type DeviceSelectionController } from './scan.js';

export type { DeviceSelectionController, DiscoveredDevice } from './scan.js';

export type ReconnectState = 'reconnecting' | 'reconnected' | 'failed';

export interface TauriBlecDeviceClientOptions extends GattReadyRetryOptions {
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

const DEFAULT_RECONNECT_ATTEMPTS = 3;
const DEFAULT_RECONNECT_BACKOFF_MS = [500, 1500, 4000];

/**
 * A `DeviceClient` scoped to ONE Coyote connection, identified by BLE
 * address once connected. The multi-connection fork this package is pinned
 * to (`0xNullAI/tauri-plugin-blec-multi`) lets several `TauriBlecDeviceClient`
 * (and Opossum/sensor client) instances stay connected at the same time —
 * this class never assumes it's the only connection, so it always passes
 * its own `address` to plugin-blec instead of relying on the address-less
 * "sole connected device" overloads (which now throw `AmbiguousDevice` once
 * a second device connects).
 */
export class TauriBlecDeviceClient implements DeviceClient {
  private readonly listeners = new Set<(state: DeviceState) => void>();
  private connected = false;
  private connecting = false;
  private disconnecting = false;
  private fireDisconnect: (() => void) | null = null;
  /**
   * Address of the currently-connected device, or (while disconnected) the
   * last-connected address kept only for auto-reconnect.
   */
  private lastAddress: string | null = null;
  private lastDeviceName = '';
  private reconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Set only while connected via `connectDevice()` (the unified-picker
   * passthrough) instead of this client's own `connect()`. Tracked
   * separately from `lastAddress`/`fireDisconnect` so `disconnect()` can
   * tear down through the device's own `gatt.disconnect()` — the shim
   * `connectDevice()` was handed already wires `fireDisconnect` +
   * `api.disconnect()` together, so replaying both here would double up.
   * A reconnect always re-establishes through `establishConnection()`
   * (fresh `api.connect()` + a brand-new shim), which clears this back to
   * `null`, so it's stale exactly never past the first passive drop.
   */
  private passthroughDevice: BluetoothDeviceLike | null = null;

  constructor(private readonly options: TauriBlecDeviceClientOptions) {
    this.options.protocol.subscribe((state) => {
      for (const l of this.listeners) l(state);
    });
  }

  /** The BLE address of the currently-connected device, or `null` if disconnected. */
  get address(): string | null {
    return this.connected ? this.lastAddress : null;
  }

  async connect(): Promise<void> {
    // Reentrancy guard: double-tap on the connect button must not start
    // two parallel scans or two plugin-blec.connect() calls for THIS
    // client. A reconnect attempt sets `connecting` for the same reason
    // while it's actually inside plugin-blec.connect(), so this guard also
    // rejects a manual connect() that lands mid-attempt instead of racing
    // it. Other `TauriBlecDeviceClient`/aux-client instances connecting to
    // their own addresses concurrently are unaffected — this guard is
    // per-instance, not global (plugin-blec itself supports concurrent
    // connects to different addresses).
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

    const picked = await scanAndSelectDevice(api, {
      selectDevice: this.options.selectDevice,
      namePrefixes: this.options.namePrefixes,
      scanDurationMs: this.options.scanDurationMs,
    });

    if (!picked) {
      throw new Error('用户取消了设备选择');
    }

    await this.establishConnection(picked.address, picked.name);
  }

  /**
   * Attach to an already-obtained, already-plugin-blec-connected
   * `(device, server)` pair instead of running this client's own scan +
   * `selectDevice()` + `api.connect()`. Lets a caller that already ran ONE
   * shared scan+picker across every DG-Lab device kind
   * (`requestDgLabDeviceTauri()`) and identified the picked device as a
   * Coyote via `detectDeviceKind()` hand the device straight to this
   * client, rather than needing a second, Coyote-only scan+picker. Mirrors
   * `@dg-kit/transport-webbluetooth`'s `WebBluetoothDeviceClient.connectDevice()`.
   */
  async connectDevice(
    device: BluetoothDeviceLike,
    server: BluetoothRemoteGATTServerLike,
  ): Promise<void> {
    if (this.connected) {
      throw new Error('设备已连接');
    }
    if (this.connecting) {
      throw new Error('正在连接中，请稍候');
    }
    this.cancelReconnect();
    this.connecting = true;
    try {
      await this.attachConnection(device, server);
    } finally {
      this.connecting = false;
    }
  }

  /**
   * The `connectDevice()` counterpart to `establishConnection()`: runs the
   * GATT-ready-retried protocol handshake against an already-connected
   * `(device, server)` pair instead of driving `api.connect()` itself.
   * `device`'s `gattserverdisconnected` event (fired by the shim the caller
   * built via `createGattShim()`) is this client's only signal of an
   * unexpected drop, since the plugin-blec-level `onDisconnect` callback was
   * already claimed by whoever called `api.connect()` — wiring a DOM
   * listener here reaches the same `handlePluginDisconnectSignal()` path
   * `establishConnection()`'s direct callback reaches, so autoReconnect
   * behaves identically regardless of which path made the connection.
   */
  private async attachConnection(
    device: BluetoothDeviceLike,
    server: BluetoothRemoteGATTServerLike,
  ): Promise<void> {
    const address = device.id ?? '';
    try {
      await runWithGattReadyRetry(
        () => this.options.protocol.onConnected({ device, server }),
        this.options,
      );
    } catch (error) {
      if (device.gatt?.connected) {
        device.gatt.disconnect();
      } else {
        const api = await resolvePluginBlec();
        await api.disconnect(address).catch(() => undefined);
      }
      throw error;
    }

    this.connected = true;
    this.lastAddress = address;
    this.lastDeviceName = device.name ?? '';
    this.passthroughDevice = device;
    // `device.gatt.disconnect()` is the shim's own teardown method: it fires
    // `gattserverdisconnected` AND calls `api.disconnect()`. `disconnect()`
    // below already calls `api.disconnect()` explicitly before invoking
    // `fireDisconnect()`, so the second call this triggers is a harmless,
    // already-caught no-op — same tolerance every plugin-blec call in this
    // file has for a repeat teardown of an address that's already gone.
    this.fireDisconnect = () => {
      device.gatt?.disconnect();
    };
    device.addEventListener('gattserverdisconnected', this.handlePassthroughDisconnect);
  }

  private readonly handlePassthroughDisconnect = (): void => {
    this.connected = false;
    if (this.passthroughDevice) {
      this.passthroughDevice.removeEventListener(
        'gattserverdisconnected',
        this.handlePassthroughDisconnect,
      );
      this.passthroughDevice = null;
    }
    this.handlePluginDisconnectSignal();
  };

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
      await runWithGattReadyRetry(
        () =>
          this.options.protocol.onConnected({
            device: shim!.device,
            server: shim!.server,
          }),
        this.options,
      );
      this.connected = true;
      this.lastAddress = address;
      this.lastDeviceName = name;
      // A previous `connectDevice()` passthrough's listener is now moot —
      // this establishConnection() call owns `fireDisconnect`/state going
      // forward (see the field's doc comment).
      this.passthroughDevice = null;
    } catch (error) {
      await api.disconnect(address).catch(() => undefined);
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
    const address = this.lastAddress;
    await this.options.protocol.emergencyStop().catch(() => undefined);
    this.connected = false;
    this.lastAddress = null;
    this.fireDisconnect?.();
    this.fireDisconnect = null;
    const api = await resolvePluginBlec();
    await api.disconnect(address ?? undefined).catch(() => undefined);
    await this.options.protocol.onDisconnected().catch(() => undefined);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnecting = false;
  }

  async disconnect(): Promise<void> {
    // A reconnect attempt may be scheduled or actively in flight even while
    // `connected` is false (it flips true only once establishConnection
    // succeeds) — still run the teardown machinery below so we cancel it.
    const hadReconnectPending = this.reconnecting;
    if (!this.connected && !hadReconnectPending) return;

    // Capture the address before it's forgotten below — plugin-blec's
    // `disconnect()` needs it explicitly now that other devices may be
    // connected concurrently (the address-less overload only works when
    // this is the sole connected device, which is no longer guaranteed).
    const address = this.lastAddress;

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
        // A `connectDevice()` passthrough's listener must come off BEFORE
        // `fireDisconnect()` below (which, for a passthrough connection,
        // calls the shim's own `gatt.disconnect()` and so fires this same
        // event) — otherwise `handlePassthroughDisconnect` would reach
        // `protocol.onDisconnected()` a second time, mirroring
        // `disconnectTauriAuxDevice()`'s identical ordering requirement.
        if (this.passthroughDevice) {
          this.passthroughDevice.removeEventListener(
            'gattserverdisconnected',
            this.handlePassthroughDisconnect,
          );
          this.passthroughDevice = null;
        }
        const api = await resolvePluginBlec();
        await api.disconnect(address ?? undefined).catch(() => undefined);
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
