/**
 * Typed shim over @mnlphlp/plugin-blec.
 *
 * The rest of this package only talks to the `PluginBlecApi` interface so
 * plugin-blec can be mocked in tests and (one day) swapped for an alternative
 * Tauri BLE plugin without touching consumers.
 */

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

export interface PluginBlecApi {
  /**
   * `askIfDenied=true` triggers the system permission dialog if the app does
   * not already have the bluetooth permissions.
   */
  checkPermissions: (askIfDenied?: boolean) => Promise<boolean>;
  startScan: (
    handler: (devices: BleDeviceInfo[]) => void,
    timeoutMs: number,
  ) => Promise<void>;
  stopScan: () => Promise<void>;
  connect: (address: string, onDisconnect: (() => void) | null) => Promise<void>;
  disconnect: () => Promise<void>;
  send: (
    characteristic: string,
    data: number[],
    writeType?: WriteType,
    service?: string,
  ) => Promise<void>;
  read: (characteristic: string, service?: string) => Promise<number[]>;
  subscribe: (
    characteristic: string,
    handler: (data: number[]) => void,
  ) => Promise<void>;
  unsubscribe: (characteristic: string) => Promise<void>;
}

let injected: PluginBlecApi | undefined;

export function __setPluginBlecForTests(api: PluginBlecApi | undefined): void {
  injected = api;
}

export async function resolvePluginBlec(): Promise<PluginBlecApi> {
  if (injected) return injected;
  const win = (globalThis as { window?: { __TAURI_INTERNALS__?: unknown } }).window;
  if (!win?.__TAURI_INTERNALS__) {
    throw new Error(
      '@mnlphlp/plugin-blec 不可用：当前未运行在已注册 blec 插件的 Tauri 壳中',
    );
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
    checkPermissions: (askIfDenied) => mod.checkPermissions(askIfDenied),
    startScan: (handler, timeoutMs) => mod.startScan(handler, timeoutMs),
    stopScan: () => mod.stopScan(),
    connect: (address, onDisconnect) => mod.connect(address, onDisconnect),
    disconnect: () => mod.disconnect(),
    send: (characteristic, data, writeType, service) =>
      mod.send(characteristic, data, writeType, service),
    read: (characteristic, service) => mod.read(characteristic, service),
    subscribe: (characteristic, handler) => mod.subscribe(characteristic, handler),
    unsubscribe: (characteristic) => mod.unsubscribe(characteristic),
  };
}
