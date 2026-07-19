import type { DeviceClient } from '@dg-kit/core';
import type { DeviceCommand, DeviceCommandResult, DeviceState } from '@dg-kit/core';
import {
  DG_LAB_REQUEST_DEVICE_OPTIONS,
  type BluetoothDeviceLike,
  type BluetoothRemoteGATTServerLike,
  type NavigatorBluetoothLike,
  type RequestDeviceOptionsLike,
  type WebBluetoothProtocolAdapter,
} from '@dg-kit/protocol';
import { getWebBluetoothAvailability } from './availability.js';

export type ReconnectState = 'reconnecting' | 'reconnected' | 'failed';

const DEFAULT_RECONNECT_ATTEMPTS = 3;
const DEFAULT_RECONNECT_BACKOFF_MS = [500, 1500, 4000];

export interface WebBluetoothDeviceClientOptions {
  protocol: WebBluetoothProtocolAdapter;
  navigatorRef?: NavigatorBluetoothLike;
  requestDeviceOptions?: RequestDeviceOptionsLike;
  /**
   * When true, a passive `gattserverdisconnected` event triggers a silent
   * reconnect attempt using the cached `BluetoothDevice` reference (which
   * survives without re-prompting the user). The user-initiated
   * `disconnect()` path always cancels any in-flight reconnect.
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

export class WebBluetoothDeviceClient implements DeviceClient {
  private readonly listeners = new Set<(state: DeviceState) => void>();
  private readonly nav: NavigatorBluetoothLike | undefined;
  private device: EventTarget | null = null;
  private disconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnecting = false;

  constructor(private readonly options: WebBluetoothDeviceClientOptions) {
    this.nav =
      options.navigatorRef ??
      (typeof navigator === 'undefined'
        ? undefined
        : (navigator as unknown as NavigatorBluetoothLike));

    this.options.protocol.subscribe((state) => {
      this.emit(state);
    });
  }

  async connect(): Promise<void> {
    this.cancelReconnect();

    const availability = getWebBluetoothAvailability(this.nav);
    if (!availability.supported) {
      throw new Error(availability.reason);
    }

    const bluetooth = this.nav?.bluetooth;
    if (!bluetooth) {
      throw new Error('当前环境不支持 Web Bluetooth');
    }

    const nextDevice = await bluetooth.requestDevice(
      this.options.requestDeviceOptions ?? DG_LAB_REQUEST_DEVICE_OPTIONS,
    );
    const gatt = nextDevice.gatt;

    if (!gatt) {
      throw new Error('所选蓝牙设备不支持 GATT');
    }

    const server = await gatt.connect();
    await this.connectDevice(nextDevice, server);
  }

  /**
   * Attach to an already-obtained `(device, server)` pair instead of running
   * this client's own `bluetooth.requestDevice()` chooser prompt.
   *
   * Lets a caller that already ran ONE shared chooser scoped to every DG-Lab
   * device kind (Coyote + sensors + Opossum — see `DG_LAB_REQUEST_DEVICE_OPTIONS`)
   * and identified the picked device as a Coyote via `detectDeviceKind()`
   * hand the device straight to this client, rather than needing a second,
   * Coyote-only chooser prompt. `gatt.connect()` must already have been
   * called by the caller; this method only runs the protocol handshake and
   * the same replace-previous-device bookkeeping `connect()` does.
   */
  async connectDevice(
    nextDevice: BluetoothDeviceLike,
    server: BluetoothRemoteGATTServerLike,
  ): Promise<void> {
    this.cancelReconnect();
    const previousDevice = this.device as BluetoothDeviceLike | null;
    const shouldReplacePrevious = !!previousDevice && previousDevice !== nextDevice;

    if (shouldReplacePrevious) {
      previousDevice.removeEventListener('gattserverdisconnected', this.onDisconnected);
    }

    try {
      await this.options.protocol.onConnected({ device: nextDevice, server });
    } catch (error) {
      if (shouldReplacePrevious && isGattConnected(previousDevice)) {
        previousDevice.addEventListener('gattserverdisconnected', this.onDisconnected);
      }
      if (nextDevice.gatt?.connected) {
        nextDevice.gatt.disconnect();
      }
      throw error;
    }

    this.device = nextDevice;
    nextDevice.addEventListener('gattserverdisconnected', this.onDisconnected);

    if (shouldReplacePrevious) {
      disconnectDevice(previousDevice);
    }
  }

  async disconnect(): Promise<void> {
    this.disconnecting = true;
    this.cancelReconnect();
    try {
      await this.options.protocol.emergencyStop();
      const device = this.device as { gatt?: { connected: boolean; disconnect(): void } } | null;
      if (device?.gatt?.connected) {
        device.gatt.disconnect();
      }
      await this.options.protocol.onDisconnected();
    } finally {
      // A `gattserverdisconnected` event that landed mid-disconnect may have
      // scheduled a reconnect while we were awaiting; clear it again so the
      // timer can't fire after we've returned.
      this.cancelReconnect();
      if (this.device) {
        this.device.removeEventListener('gattserverdisconnected', this.onDisconnected);
      }
      this.device = null;
      this.disconnecting = false;
    }
  }

  async getState(): Promise<DeviceState> {
    return this.options.protocol.getState();
  }

  async execute(command: DeviceCommand): Promise<DeviceCommandResult> {
    return this.options.protocol.execute(command);
  }

  async emergencyStop(): Promise<void> {
    await this.options.protocol.emergencyStop();
  }

  onStateChanged(listener: (state: DeviceState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private readonly onDisconnected = async (): Promise<void> => {
    if (this.disconnecting) return;
    if (this.reconnecting) return;

    // Tell the protocol we're disconnected so UI / queue stop accepting
    // writes; if the reconnect succeeds the protocol's onConnected will
    // flip it back. Holding the device reference is what lets the
    // reconnect skip the chooser prompt — drop it only after we give up.
    await this.options.protocol.onDisconnected();

    // A user-initiated disconnect may have run while we awaited.
    if (this.disconnecting) return;

    if (this.options.autoReconnect && this.device) {
      this.scheduleReconnect(1);
      return;
    }

    if (this.device) {
      this.device.removeEventListener('gattserverdisconnected', this.onDisconnected);
    }
    this.device = null;
  };

  private scheduleReconnect(attempt: number): void {
    const maxAttempts = this.options.reconnectAttempts ?? DEFAULT_RECONNECT_ATTEMPTS;
    if (attempt > maxAttempts) {
      this.options.onReconnectStateChange?.('failed');
      if (this.device) {
        this.device.removeEventListener('gattserverdisconnected', this.onDisconnected);
      }
      this.device = null;
      return;
    }

    this.reconnecting = true;
    this.options.onReconnectStateChange?.('reconnecting');

    const backoff = this.options.reconnectBackoffMs ?? DEFAULT_RECONNECT_BACKOFF_MS;
    // Reuse the last entry when attempts outrun the backoff schedule.
    const delay = backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 0;

    this.reconnectTimer = setTimeout(() => {
      void this.tryReconnect(attempt);
    }, delay);
  }

  private async tryReconnect(attempt: number): Promise<void> {
    this.reconnectTimer = null;
    if (this.disconnecting) {
      this.reconnecting = false;
      return;
    }

    const device = this.device as BluetoothDeviceLike | null;
    const gatt = device?.gatt;
    if (!device || !gatt) {
      this.reconnecting = false;
      this.options.onReconnectStateChange?.('failed');
      this.device = null;
      return;
    }

    try {
      // gatt.connect() is idempotent per the Web Bluetooth spec — calling it
      // when already connected returns the existing server. So we always go
      // through it instead of branching on `gatt.connected`.
      const server = await gatt.connect();
      // User may have hit disconnect while we waited for the GATT server.
      if (this.disconnecting || this.device !== device) {
        this.reconnecting = false;
        return;
      }
      await this.options.protocol.onConnected({ device, server });
      this.reconnecting = false;
      this.options.onReconnectStateChange?.('reconnected');
    } catch {
      if (this.disconnecting) {
        this.reconnecting = false;
        return;
      }
      this.reconnecting = false;
      this.scheduleReconnect(attempt + 1);
    }
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnecting = false;
  }

  private emit(state: DeviceState): void {
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}

function isGattConnected(device: BluetoothDeviceLike | null): boolean {
  return !!device?.gatt?.connected;
}

function disconnectDevice(device: BluetoothDeviceLike | null): void {
  if (!device) return;
  const gatt = device.gatt;
  if (!gatt?.connected) return;
  gatt.disconnect();
}
