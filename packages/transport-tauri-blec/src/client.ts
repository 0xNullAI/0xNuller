import type {
  DeviceClient,
  DeviceCommand,
  DeviceCommandResult,
  DeviceState,
} from '@dg-kit/core';
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
}

export class TauriBlecDeviceClient implements DeviceClient {
  private readonly listeners = new Set<(state: DeviceState) => void>();
  private connected = false;
  private fireDisconnect: (() => void) | null = null;

  constructor(private readonly options: TauriBlecDeviceClientOptions) {
    this.options.protocol.subscribe((state) => {
      for (const l of this.listeners) l(state);
    });
  }

  async connect(): Promise<void> {
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
        if (!prev || prev.rssi !== d.rssi) changed = true;
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
      await this.options.protocol.onConnected({
        device: shim.device,
        server: shim.server,
      });
      this.connected = true;
    } catch (error) {
      await api.disconnect().catch(() => undefined);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
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
