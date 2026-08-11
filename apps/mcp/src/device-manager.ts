/**
 * Multi-device manager: holds concurrent BLE connections keyed by (lowercased)
 * BLE address, one connection per DG-Lab device family.
 *
 * Design note: each device family gets its own adapter shape from
 * `@dg-kit/protocol` rather than being forced through one polymorphic
 * interface, because the upstream library itself doesn't unify them --
 * Coyote drives `CoyoteProtocolAdapter` (implements `WebBluetoothProtocolAdapter`,
 * `DeviceCommand`/`DeviceState`), paw-prints/civet-edging drive
 * `WebBluetoothSensorAdapter<TReading>` (event-pushing, no strength state),
 * and opossum has its own standalone `OpossumVibrateAdapter` (not
 * implementing either interface). `ConnectedDevice` is a small discriminated
 * union on `.kind` so callers narrow to the right adapter type instead of
 * casting.
 */

import type { DeviceKind, DeviceState, SensorState } from '@dg-kit/core';
import {
  CivetPressureSensorAdapter,
  CoyoteProtocolAdapter,
  OpossumVibrateAdapter,
  PawPrintsSensorAdapter,
  detectDeviceKind,
  type BluetoothDeviceLike,
  type CivetPressureReading,
  type OpossumState,
  type PawPrintsReading,
  type WebBluetoothConnectionContext,
} from '@dg-kit/protocol';
import noble, { type Peripheral, type Service } from '@stoprocent/noble';
import { NobleGATTServer } from './noble-shim.js';

export interface ScanResult {
  address: string;
  name: string;
  rssi: number;
  deviceKind: DeviceKind;
}

export type ConnectedDevice =
  | { kind: 'coyote'; address: string; peripheral: Peripheral; adapter: CoyoteProtocolAdapter }
  | {
      kind: 'paw-prints';
      address: string;
      peripheral: Peripheral;
      adapter: PawPrintsSensorAdapter;
    }
  | {
      kind: 'civet-edging';
      address: string;
      peripheral: Peripheral;
      adapter: CivetPressureSensorAdapter;
    }
  | { kind: 'opossum'; address: string; peripheral: Peripheral; adapter: OpossumVibrateAdapter };

export interface SensorSnapshot {
  address: string;
  deviceKind: 'paw-prints' | 'civet-edging';
  state: SensorState;
  latestReading: PawPrintsReading | CivetPressureReading | null;
  receivedAt: number | null;
}

/** Chinese labels for error messages -- keeps them consistent across call sites. */
const DEVICE_KIND_LABEL: Record<DeviceKind, string> = {
  coyote: '郊狼',
  'paw-prints': '爪印',
  'civet-edging': '灵猫边缘控制',
  opossum: '负鼠',
};

interface SensorCacheEntry {
  reading: PawPrintsReading | CivetPressureReading;
  receivedAt: number;
}

export class DeviceManager {
  private readonly devices = new Map<string, ConnectedDevice>();
  private readonly sensorReadingCache = new Map<string, SensorCacheEntry>();

  /** Scan for nearby known DG-Lab devices for `timeoutMs` and return candidates. */
  async scan(timeoutMs = 5_000): Promise<ScanResult[]> {
    await waitForPoweredOn();

    const found = new Map<string, ScanResult>();
    const onDiscover = (p: Peripheral): void => {
      const name = p.advertisement?.localName ?? '';
      const deviceKind = detectDeviceKind(name);
      if (deviceKind === 'unknown') return;
      if (found.has(p.address)) return;
      found.set(p.address, { address: p.address, name, rssi: p.rssi, deviceKind });
    };

    noble.on('discover', onDiscover);
    try {
      await noble.startScanningAsync([], false);
      await sleep(timeoutMs);
    } finally {
      noble.removeListener('discover', onDiscover);
      try {
        await noble.stopScanningAsync();
      } catch {
        // ignore
      }
    }

    return [...found.values()];
  }

  /**
   * Connect to a device by its BLE address. Detects the device family via
   * `detectDeviceKind()` and constructs the matching adapter. Rejects a
   * second connect for an address that's already connected.
   */
  async connect(address: string): Promise<{ address: string; deviceKind: DeviceKind }> {
    const key = normalizeAddress(address);
    if (this.devices.has(key)) {
      throw new Error(`设备 ${address} 已连接，请先 disconnect 后再重新连接`);
    }

    await waitForPoweredOn();

    const peripheral = await this.findPeripheralByAddress(address);
    const name = peripheral.advertisement?.localName ?? '';
    const deviceKind = detectDeviceKind(name);
    if (deviceKind === 'unknown') {
      throw new Error(`无法识别设备类型（广播名：${name || '未知'}），暂不支持连接`);
    }

    await peripheral.connectAsync();
    const { services } = await peripheral.discoverAllServicesAndCharacteristicsAsync();
    const context = createConnectionContext(peripheral, services);

    try {
      const entry = await this.buildConnectedDevice(deviceKind, key, peripheral, context);
      this.devices.set(key, entry);
      return { address: peripheral.address, deviceKind };
    } catch (error) {
      try {
        await peripheral.disconnectAsync();
      } catch {
        // ignore best-effort cleanup failure
      }
      throw error;
    }
  }

  /** Disconnect one device by address, or every connected device if omitted. */
  async disconnect(address?: string): Promise<void> {
    if (address) {
      const entry = this.requireDevice(address);
      await this.disconnectEntry(entry);
      return;
    }

    const entries = [...this.devices.values()];
    await Promise.all(entries.map((entry) => this.disconnectEntry(entry)));
  }

  /** Best-effort safety stop on every connected device that can output (coyote/opossum). */
  async emergencyStopAll(): Promise<void> {
    await Promise.all(
      [...this.devices.values()].map(async (entry) => {
        if (entry.kind === 'coyote' || entry.kind === 'opossum') {
          try {
            await entry.adapter.emergencyStop();
          } catch {
            // best-effort: device may already be gone
          }
        }
      }),
    );
  }

  /** `{ address, deviceKind, connected }` for everything in the manager. */
  list(): Array<{ address: string; deviceKind: DeviceKind; connected: boolean }> {
    return [...this.devices.values()].map((entry) => ({
      address: entry.address,
      deviceKind: entry.kind,
      connected: entry.adapter.getState().connected,
    }));
  }

  /** Status (device-family-shaped state) for every connected device. */
  getStatuses(): Array<{
    address: string;
    deviceKind: DeviceKind;
    state: DeviceState | SensorState | OpossumState;
  }> {
    return [...this.devices.values()].map((entry) => ({
      address: entry.address,
      deviceKind: entry.kind,
      state: entry.adapter.getState(),
    }));
  }

  /**
   * Latest cached reading for paw-prints/civet-edging sensors. These are
   * event streams, not polled state, so the manager caches the most recent
   * reading per device as it arrives via `subscribe()` in `connect()`.
   */
  getSensorSnapshots(address?: string): SensorSnapshot[] {
    const entries = (address ? [this.requireDevice(address)] : [...this.devices.values()]).filter(
      (entry): entry is Extract<ConnectedDevice, { kind: 'paw-prints' | 'civet-edging' }> =>
        entry.kind === 'paw-prints' || entry.kind === 'civet-edging',
    );

    return entries.map((entry) => {
      const cached = this.sensorReadingCache.get(entry.address);
      return {
        address: entry.address,
        deviceKind: entry.kind,
        state: entry.adapter.getState(),
        latestReading: cached?.reading ?? null,
        receivedAt: cached?.receivedAt ?? null,
      };
    });
  }

  /**
   * Find the single connected device of a given kind. Throws a clear error
   * if zero or more than one match -- multi-device-of-the-same-kind
   * targeting isn't solved here, callers must disconnect extras first.
   */
  findSingleByKind<K extends DeviceKind>(kind: K): Extract<ConnectedDevice, { kind: K }> {
    const matches = [...this.devices.values()].filter(
      (entry): entry is Extract<ConnectedDevice, { kind: K }> => entry.kind === kind,
    );

    if (matches.length === 0) {
      throw new Error(`没有已连接的${DEVICE_KIND_LABEL[kind]}设备`);
    }
    if (matches.length > 1) {
      throw new Error(
        `检测到 ${matches.length} 台已连接的${DEVICE_KIND_LABEL[kind]}设备，请先 disconnect 断开多余设备后再操作`,
      );
    }

    return matches[0] as Extract<ConnectedDevice, { kind: K }>;
  }

  private async buildConnectedDevice(
    kind: DeviceKind,
    address: string,
    peripheral: Peripheral,
    context: WebBluetoothConnectionContext,
  ): Promise<ConnectedDevice> {
    switch (kind) {
      case 'coyote': {
        const adapter = new CoyoteProtocolAdapter();
        await adapter.onConnected(context);
        return { kind: 'coyote', address, peripheral, adapter };
      }
      case 'paw-prints': {
        const adapter = new PawPrintsSensorAdapter();
        await adapter.onConnected(context);
        adapter.subscribe((reading) => {
          this.sensorReadingCache.set(address, { reading, receivedAt: Date.now() });
        });
        return { kind: 'paw-prints', address, peripheral, adapter };
      }
      case 'civet-edging': {
        const adapter = new CivetPressureSensorAdapter();
        await adapter.onConnected(context);
        adapter.subscribe((reading) => {
          this.sensorReadingCache.set(address, { reading, receivedAt: Date.now() });
        });
        return { kind: 'civet-edging', address, peripheral, adapter };
      }
      case 'opossum': {
        const adapter = new OpossumVibrateAdapter();
        await adapter.onConnected(context);
        return { kind: 'opossum', address, peripheral, adapter };
      }
    }
  }

  private async disconnectEntry(entry: ConnectedDevice): Promise<void> {
    try {
      if (entry.kind === 'coyote' || entry.kind === 'opossum') {
        try {
          await entry.adapter.emergencyStop();
        } catch {
          // best-effort: device may already be gone
        }
      }
      await entry.adapter.onDisconnected();
    } finally {
      try {
        await entry.peripheral.disconnectAsync();
      } catch {
        // ignore
      }
      this.devices.delete(entry.address);
      this.sensorReadingCache.delete(entry.address);
    }
  }

  private requireDevice(address: string): ConnectedDevice {
    const entry = this.devices.get(normalizeAddress(address));
    if (!entry) {
      throw new Error(`设备 ${address} 未连接`);
    }
    return entry;
  }

  private async findPeripheralByAddress(address: string, timeoutMs = 10_000): Promise<Peripheral> {
    let peripheral: Peripheral | null = null;
    const onDiscover = (p: Peripheral): void => {
      if (p.address.toLowerCase() === address.toLowerCase()) {
        peripheral = p;
        void noble.stopScanningAsync().catch(() => undefined);
      }
    };

    noble.on('discover', onDiscover);
    try {
      await noble.startScanningAsync([], false);
      const start = Date.now();
      while (!peripheral && Date.now() - start < timeoutMs) {
        await sleep(100);
      }
    } finally {
      noble.removeListener('discover', onDiscover);
      try {
        await noble.stopScanningAsync();
      } catch {
        // ignore
      }
    }

    if (!peripheral) {
      throw new Error(`设备 ${address} 在 ${timeoutMs}ms 内未找到`);
    }
    return peripheral;
  }
}

function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

function createConnectionContext(
  peripheral: Peripheral,
  services: Service[],
): WebBluetoothConnectionContext {
  const server = new NobleGATTServer(peripheral, services);
  const device = {
    id: peripheral.address,
    name: peripheral.advertisement?.localName ?? '',
    gatt: {
      connected: peripheral.state === 'connected',
      async connect() {
        return server;
      },
      disconnect: () => {
        void peripheral.disconnectAsync().catch(() => undefined);
      },
    },
    addEventListener: (type: string, handler: ((event: Event) => void) | null): void => {
      if (type === 'gattserverdisconnected' && typeof handler === 'function') {
        peripheral.once('disconnect', () => handler(new Event(type)));
      }
    },
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  } as unknown as BluetoothDeviceLike;

  return { device, server };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let poweredOnPromise: Promise<void> | null = null;

function waitForPoweredOn(): Promise<void> {
  if (noble.state === 'poweredOn') return Promise.resolve();
  if (poweredOnPromise) return poweredOnPromise;
  poweredOnPromise = new Promise((resolve, reject) => {
    const onChange = (state: string): void => {
      if (state === 'poweredOn') {
        noble.removeListener('stateChange', onChange);
        resolve();
      } else if (state === 'unsupported' || state === 'unauthorized') {
        noble.removeListener('stateChange', onChange);
        reject(new Error(`BLE adapter unavailable: ${state}`));
      }
    };
    noble.on('stateChange', onChange);
  });
  return poweredOnPromise;
}
