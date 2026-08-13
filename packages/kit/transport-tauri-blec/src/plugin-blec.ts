/**
 * Typed shim over @mnlphlp/plugin-blec.
 *
 * The rest of this package only talks to the `PluginBlecApi` interface so
 * plugin-blec can be mocked in tests and (one day) swapped for an alternative
 * Tauri BLE plugin without touching consumers.
 */

import { invoke } from '@tauri-apps/api/core';

export interface BleDeviceInfo {
  address: string;
  name: string;
  rssi: number;
  isConnected: boolean;
  isBonded: boolean;
  services: string[];
  manufacturerData: Record<number, number[]>;
  serviceData: Record<string, number[]>;
}

export type WriteType = 'withResponse' | 'withoutResponse';

export interface BleGattServiceInfo {
  uuid: string;
  characteristics: Array<{ uuid: string; descriptors: string[]; properties: number }>;
}

export interface PluginBlecApi {
  /**
   * `askIfDenied=true` triggers the system permission dialog if the app does
   * not already have the permissions. Android 11 and older also request the
   * location permission required by the platform for BLE discovery.
   */
  checkPermissions: (askIfDenied?: boolean) => Promise<boolean>;
  startScan: (handler: (devices: BleDeviceInfo[]) => void, timeoutMs: number) => Promise<void>;
  stopScan: () => Promise<void>;
  /**
   * Connect to a device. Connecting to a new address does not disconnect any
   * other address that's already connected — the fork this package is
   * pinned to (`0xNullAI/tauri-plugin-blec-multi`) tracks each connection
   * independently, so a Coyote client and an Opossum/sensor client can stay
   * connected at the same time.
   */
  connect: (address: string, onDisconnect: (() => void) | null) => Promise<void>;
  /**
   * `address` is optional only for backward compatibility with the
   * upstream single-connection API — it rejects with `AmbiguousDevice` if
   * omitted while 2+ devices are connected. Every call in this package
   * passes it explicitly (each `PluginBlecCharacteristic`/`TauriBlecDeviceClient`
   * instance is scoped to one address) so that never happens here.
   */
  disconnect: (address?: string) => Promise<void>;
  /** List every currently-connected device, across all addresses. */
  connectedDevices: () => Promise<BleDeviceInfo[]>;
  /**
   * Discover a candidate's GATT services. The native plugin temporarily
   * connects and disconnects when the device is not already connected.
   */
  listServices: (address: string) => Promise<BleGattServiceInfo[]>;
  /**
   * Per-device connection state stream. Unlike a hypothetical aggregate
   * "connected" flag, this only fires for `address`, so it stays correct
   * when multiple devices are connected concurrently.
   */
  getDeviceConnectionUpdates: (
    address: string,
    handler: (connected: boolean) => void,
  ) => Promise<void>;
  send: (
    characteristic: string,
    data: number[],
    writeType?: WriteType,
    service?: string,
    address?: string,
  ) => Promise<void>;
  read: (characteristic: string, service?: string, address?: string) => Promise<number[]>;
  subscribe: (
    characteristic: string,
    service: string | null,
    handler: (data: number[]) => void,
    address?: string,
  ) => Promise<void>;
  unsubscribe: (characteristic: string, service?: string, address?: string) => Promise<void>;
  /** MTU of a connected device, in bytes. */
  getMtu: (address?: string) => Promise<number>;
  /** Request the Android BLE MTU used by the DG-LAB Opossum protocol. */
  setAndroidMtu?: (mtu: number) => Promise<void>;
}

let injected: PluginBlecApi | undefined;

export function __setPluginBlecForTests(api: PluginBlecApi | undefined): void {
  injected = api;
}

export async function resolvePluginBlec(): Promise<PluginBlecApi> {
  if (injected) return injected;
  const win = (globalThis as { window?: { __TAURI_INTERNALS__?: unknown } }).window;
  if (!win?.__TAURI_INTERNALS__) {
    throw new Error('@mnlphlp/plugin-blec 不可用：当前未运行在已注册 blec 插件的 Tauri 壳中');
  }
  try {
    const mod = await import('@mnlphlp/plugin-blec');
    return mapModule(mod);
  } catch (cause) {
    const err = new Error('@mnlphlp/plugin-blec 加载失败：请确认依赖已安装且 Tauri 已注册插件');
    (err as Error & { cause?: unknown }).cause = cause;
    throw err;
  }
}

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type PluginBlecModule = typeof import('@mnlphlp/plugin-blec');

function mapModule(mod: PluginBlecModule): PluginBlecApi {
  return {
    checkPermissions: async (askIfDenied = true) => {
      // The plugin's public JS helper only forwards `askIfDenied`; its native
      // Android command has a separate `allowIbeacons` flag which is what
      // actually adds ACCESS_FINE_LOCATION to the requested aliases. Without
      // it Android <= 11 reports permission success but silently returns an
      // empty BLE scan. Do not request it on Android 12+, where Nearby Devices
      // replaced location for BLE discovery.
      if (legacyAndroidNeedsLocation()) {
        return invoke<boolean>('plugin:blec|check_permissions', {
          askIfDenied,
          allowIbeacons: true,
        });
      }
      return mod.checkPermissions(askIfDenied);
    },
    // Android 11 still needs the plugin's iBeacon/location scan mode flag even
    // after ACCESS_FINE_LOCATION has been granted. Without forwarding it the
    // native scanner registers successfully but returns zero advertisements.
    startScan: (handler, timeoutMs) =>
      mod.startScan(handler, timeoutMs, legacyAndroidNeedsLocation()),
    stopScan: () => mod.stopScan(),
    connect: (address, onDisconnect) =>
      mod.connect(address, onDisconnect, legacyAndroidNeedsLocation()),
    disconnect: (address) => mod.disconnect(address),
    connectedDevices: () => mod.connectedDevices(),
    listServices: async (address) => {
      const result = await mod.listServices(address);
      if (typeof result === 'string') return JSON.parse(result) as BleGattServiceInfo[];
      return result;
    },
    getDeviceConnectionUpdates: (address, handler) =>
      mod.getDeviceConnectionUpdates(address, handler),
    send: (characteristic, data, writeType, service, address) =>
      mod.send(characteristic, data, writeType, service, address),
    read: (characteristic, service, address) => mod.read(characteristic, service, address),
    subscribe: (characteristic, service, handler, address) =>
      mod.subscribe(characteristic, service, handler, address),
    unsubscribe: (characteristic, service, address) =>
      mod.unsubscribe(characteristic, service, address),
    getMtu: (address) => mod.getMtu(address),
    setAndroidMtu: (mtu) => mod.setAndroidMtu(mtu),
  };
}

function legacyAndroidNeedsLocation(): boolean {
  const match = globalThis.navigator?.userAgent.match(/Android\s+(\d+)/i);
  return match !== null && Number(match[1]) <= 11;
}
