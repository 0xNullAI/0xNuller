import { vi } from 'vitest';
import type { BleDeviceInfo, PluginBlecApi } from './plugin-blec.js';

/** Shared `PluginBlecApi` stub builder, used across this package's test files. */
export function makeApi(overrides: Partial<PluginBlecApi> = {}): PluginBlecApi {
  return {
    checkPermissions: vi.fn().mockResolvedValue(true),
    startScan: vi.fn().mockResolvedValue(undefined),
    stopScan: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    connectedDevices: vi.fn().mockResolvedValue([]),
    getDeviceConnectionUpdates: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockResolvedValue([]),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    getMtu: vi.fn().mockResolvedValue(23),
    ...overrides,
  };
}

export function makeDevice(over: Partial<BleDeviceInfo> = {}): BleDeviceInfo {
  return {
    address: 'AA:BB:CC',
    name: '47L1210000XX',
    rssi: -60,
    isConnected: false,
    isBonded: false,
    services: [],
    manufacturerData: {},
    serviceData: {},
    ...over,
  };
}
