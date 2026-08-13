import { describe, expect, it, vi } from 'vitest';
import {
  DG_LAB_TAURI_NAME_PREFIXES,
  detectAnonymousDgLabKind,
  requestDgLabDeviceTauri,
} from './request-device.js';
import { __setPluginBlecForTests, type BleDeviceInfo } from './plugin-blec.js';
import { makeApi, makeDevice } from './test-utils.js';

function scanHandlerWith(devices: BleDeviceInfo[]) {
  return vi.fn().mockImplementation(async (handler: (devices: BleDeviceInfo[]) => void) => {
    handler(devices);
  });
}

describe('requestDgLabDeviceTauri', () => {
  it('only classifies a nameless Coyote from its complete identifying service pair', () => {
    expect(
      detectAnonymousDgLabKind([
        '0000180c-0000-1000-8000-00805f9b34fb',
        '00002003-0000-1000-8000-00805f9b34fb',
        '00002004-0000-1000-8000-00805f9b34fb',
      ]),
    ).toBe('coyote');
    expect(detectAnonymousDgLabKind(['0000180c-0000-1000-8000-00805f9b34fb'])).toBe('unknown');
  });

  it('scans across every known DG-Lab prefix by default', async () => {
    const api = makeApi({ startScan: scanHandlerWith([]) });
    __setPluginBlecForTests(api);

    await expect(
      requestDgLabDeviceTauri({ selectDevice: async () => null, scanDurationMs: 50 }),
    ).rejects.toThrow(/取消/);

    // scanAndSelectDevice doesn't forward namePrefixes to startScan directly
    // (it filters client-side), so assert the constant itself is the
    // superset callers rely on instead of inspecting the startScan call.
    expect(DG_LAB_TAURI_NAME_PREFIXES).toEqual(
      expect.arrayContaining(['47L121', '47L120', '47L124', '47L127', 'D-LAB ESTIM']),
    );
  });

  it.each([
    ['47L1210000XX', 'coyote'],
    ['D-LAB ESTIM01', 'coyote'],
    ['47L1200000XX', 'paw-prints'],
    ['47L1240000XX', 'civet-edging'],
    ['47L1270000XX', 'opossum'],
  ] as const)(
    'detects %s as kind %s, connects it, and returns {kind, device, server}',
    async (name, kind) => {
      const api = makeApi({
        startScan: scanHandlerWith([makeDevice({ address: 'ADDR-1', name })]),
      });
      __setPluginBlecForTests(api);

      const result = await requestDgLabDeviceTauri({
        selectDevice: async (c) => c.initial[0]?.address ?? null,
        scanDurationMs: 50,
      });

      expect(result.kind).toBe(kind);
      expect(result.device.id).toBe('ADDR-1');
      expect(result.device.name).toBe(name);
      expect(result.server).toBeDefined();
      expect(api.connect).toHaveBeenCalledWith('ADDR-1', expect.any(Function));
    },
  );

  it('rejects an unrecognized device name without ever calling api.connect', async () => {
    // The default scan filter (`DG_LAB_TAURI_NAME_PREFIXES`) already scopes
    // results to known-good prefixes, so a non-DG-Lab name only ever reaches
    // `detectDeviceKind()` here if the caller widened `namePrefixes` beyond
    // the default (e.g. for debugging) — exercise that path directly.
    const api = makeApi({
      startScan: scanHandlerWith([makeDevice({ address: 'ADDR-1', name: 'AirPods Pro' })]),
    });
    __setPluginBlecForTests(api);

    await expect(
      requestDgLabDeviceTauri({
        selectDevice: async (c) => c.initial[0]?.address ?? null,
        namePrefixes: ['AirPods'],
        scanDurationMs: 50,
      }),
    ).rejects.toThrow(/未识别的设备/);

    expect(api.connect).not.toHaveBeenCalled();
  });

  it('exposes the official manufacturer-length fallback and verifies it after connecting', async () => {
    const api = makeApi({
      startScan: scanHandlerWith([
        makeDevice({ address: 'OPO-1', name: '', manufacturerData: { 65535: Array(8).fill(0) } }),
      ]),
      listServices: vi
        .fn()
        .mockResolvedValue([{ uuid: '0000180c-0000-1000-8000-00805f9b34fb', characteristics: [] }]),
      connectedDevices: vi
        .fn()
        .mockResolvedValue([makeDevice({ address: 'OPO-1', name: '47L1270000XX' })]),
    });
    __setPluginBlecForTests(api);

    const result = await requestDgLabDeviceTauri({
      selectDevice: async (controller) => {
        if (controller.initial[0]) return controller.initial[0].address;
        return new Promise((resolve) => {
          const off = controller.subscribe((devices) => {
            if (!devices[0]) return;
            off();
            resolve(devices[0].address);
          });
        });
      },
      scanDurationMs: 50,
    });

    expect(result.kind).toBe('opossum');
    expect(api.listServices).toHaveBeenCalledWith('OPO-1');
    expect(api.connect).toHaveBeenCalledWith('OPO-1', expect.any(Function));
  });

  it('connects a nameless Android Coyote using its verified GATT fingerprint', async () => {
    const services = [
      { uuid: '0000180c-0000-1000-8000-00805f9b34fb', characteristics: [] },
      { uuid: '00002003-0000-1000-8000-00805f9b34fb', characteristics: [] },
      { uuid: '00002004-0000-1000-8000-00805f9b34fb', characteristics: [] },
    ];
    const api = makeApi({
      startScan: scanHandlerWith([
        makeDevice({
          address: 'COYOTE-1',
          name: '',
          manufacturerData: { 42478: Array(13).fill(0) },
        }),
      ]),
      listServices: vi.fn().mockResolvedValue(services),
      connectedDevices: vi.fn().mockResolvedValue([]),
      read: vi.fn().mockRejectedValue(new Error('GAP name unavailable')),
    });
    __setPluginBlecForTests(api);

    const result = await requestDgLabDeviceTauri({
      selectDevice: async (controller) => {
        if (controller.initial[0]) return controller.initial[0].address;
        return new Promise((resolve) => {
          const off = controller.subscribe((devices) => {
            if (!devices[0]) return;
            off();
            resolve(devices[0].address);
          });
        });
      },
      scanDurationMs: 20,
    });

    expect(result.kind).toBe('coyote');
    expect(result.device.name).toBe('47L121-Android');
    expect(api.connect).toHaveBeenCalledWith('COYOTE-1', expect.any(Function));
    expect(api.disconnect).not.toHaveBeenCalled();
  });

  it('does not expose anonymous manufacturer data outside the official length range', async () => {
    const api = makeApi({
      startScan: scanHandlerWith([
        makeDevice({ address: 'AIRPODS', name: '', manufacturerData: { 76: Array(21).fill(0) } }),
      ]),
    });
    __setPluginBlecForTests(api);

    await expect(
      requestDgLabDeviceTauri({
        selectDevice: async (controller) => controller.initial[0]?.address ?? null,
        scanDurationMs: 50,
      }),
    ).rejects.toThrow(/取消/);
    expect(api.connect).not.toHaveBeenCalled();
  });

  it('throws when the user cancels the picker, without ever calling api.connect', async () => {
    const api = makeApi({
      startScan: scanHandlerWith([makeDevice({ address: 'ADDR-1', name: '47L1210000XX' })]),
    });
    __setPluginBlecForTests(api);

    await expect(
      requestDgLabDeviceTauri({ selectDevice: async () => null, scanDurationMs: 50 }),
    ).rejects.toThrow(/取消/);

    expect(api.connect).not.toHaveBeenCalled();
  });

  it('throws when BLE permission is denied, without scanning', async () => {
    const api = makeApi({ checkPermissions: vi.fn().mockResolvedValue(false) });
    __setPluginBlecForTests(api);

    await expect(
      requestDgLabDeviceTauri({ selectDevice: vi.fn(), scanDurationMs: 50 }),
    ).rejects.toThrow(/权限/);

    expect(api.startScan).not.toHaveBeenCalled();
  });

  it('honors a namePrefixes override for scoping the scan', async () => {
    const api = makeApi({
      startScan: scanHandlerWith([
        makeDevice({ address: 'A', name: '47L1210000XX' }),
        makeDevice({ address: 'B', name: '47L1270000XX' }),
      ]),
    });
    __setPluginBlecForTests(api);

    let captured: { address: string }[] = [];
    await expect(
      requestDgLabDeviceTauri({
        selectDevice: async (c) => {
          captured = c.initial;
          return null;
        },
        namePrefixes: ['47L121'],
        scanDurationMs: 50,
      }),
    ).rejects.toThrow();

    expect(captured.map((d) => d.address)).toEqual(['A']);
  });
});
