import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeApi, makeDevice } from './test-utils.js';
import { __resetPrewarmScanForTests, prewarmDeviceScan, scanAndSelectDevice } from './scan.js';

afterEach(() => {
  __resetPrewarmScanForTests();
  vi.useRealTimers();
});

describe('startup BLE prewarm', () => {
  it('does not prompt or scan when permission is absent', async () => {
    const api = makeApi({ checkPermissions: vi.fn().mockResolvedValue(false) });

    await prewarmDeviceScan(api, { namePrefixes: ['47L12'], scanDurationMs: 8000 });

    expect(api.checkPermissions).toHaveBeenCalledWith(false);
    expect(api.startScan).not.toHaveBeenCalled();
  });

  it('reuses a fresh named result as the immediate picker snapshot', async () => {
    vi.useFakeTimers();
    const cached = makeDevice({ address: 'COYOTE-1', name: '47L1210000XX', rssi: -40 });
    const api = makeApi({
      startScan: vi
        .fn()
        .mockImplementationOnce(async (handler: (devices: (typeof cached)[]) => void) => {
          handler([cached]);
        })
        .mockResolvedValueOnce(undefined),
    });

    await prewarmDeviceScan(api, { namePrefixes: ['47L12'], scanDurationMs: 8000 });
    const selectDevice = vi.fn(async (controller) => {
      expect(controller.initial).toEqual([
        expect.objectContaining({ address: 'COYOTE-1', name: '47L1210000XX' }),
      ]);
      return 'COYOTE-1';
    });

    await expect(
      scanAndSelectDevice(api, {
        selectDevice,
        namePrefixes: ['47L12'],
        scanDurationMs: 8000,
      }),
    ).resolves.toEqual({ address: 'COYOTE-1', name: '47L1210000XX', services: [] });
    expect(api.stopScan).toHaveBeenCalled();
    expect(selectDevice).toHaveBeenCalledTimes(1);
  });

  it('never exposes unrelated advertisements from the startup cache', async () => {
    vi.useFakeTimers();
    const unrelated = makeDevice({ address: 'HEADSET-1', name: 'AirPods Pro' });
    const api = makeApi({
      startScan: vi
        .fn()
        .mockImplementationOnce(async (handler: (devices: (typeof unrelated)[]) => void) => {
          handler([unrelated]);
        })
        .mockResolvedValueOnce(undefined),
    });

    await prewarmDeviceScan(api, { namePrefixes: ['47L12'], scanDurationMs: 8000 });
    const selectDevice = vi.fn(async (controller) => {
      expect(controller.initial).toEqual([]);
      return null;
    });

    await expect(
      scanAndSelectDevice(api, {
        selectDevice,
        namePrefixes: ['47L12'],
        scanDurationMs: 0,
      }),
    ).resolves.toBeNull();
  });
});
