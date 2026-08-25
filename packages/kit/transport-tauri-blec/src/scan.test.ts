import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeApi, makeDevice } from './test-utils.js';
import { __resetPrewarmScanForTests, prewarmDeviceScan, scanAndSelectDevice } from './scan.js';
import {
  __setScannerCoordinationForTests,
  type ScannerCoordinationApi,
} from './scanner-coordination.js';

afterEach(() => {
  __resetPrewarmScanForTests();
  __setScannerCoordinationForTests(undefined);
  vi.useRealTimers();
});

function makeCoordination(): ScannerCoordinationApi & {
  claim: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
} {
  return {
    claim: vi.fn().mockResolvedValue('lease-1'),
    release: vi.fn().mockResolvedValue(undefined),
  };
}

describe('startup BLE prewarm', () => {
  it('does not prompt, claim, or scan when permission is absent', async () => {
    const api = makeApi({ checkPermissions: vi.fn().mockResolvedValue(false) });
    const coordination = makeCoordination();
    __setScannerCoordinationForTests(coordination);

    await prewarmDeviceScan(api, { namePrefixes: ['47L12'], scanDurationMs: 8000 });

    expect(api.checkPermissions).toHaveBeenCalledWith(false);
    expect(coordination.claim).not.toHaveBeenCalled();
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

describe('native scanner coordination', () => {
  it('claims before scan start and releases only after stop on selection', async () => {
    const coordination = makeCoordination();
    __setScannerCoordinationForTests(coordination);
    const device = makeDevice();
    const api = makeApi({
      startScan: vi
        .fn()
        .mockImplementation(async (handler: (devices: (typeof device)[]) => void) => {
          handler([device]);
        }),
    });

    await expect(
      scanAndSelectDevice(api, {
        selectDevice: async (controller) => controller.initial[0]?.address ?? null,
        scanDurationMs: 100,
      }),
    ).resolves.toEqual({ address: device.address, name: device.name, services: [] });

    expect(coordination.claim).toHaveBeenCalledOnce();
    expect(coordination.release).toHaveBeenCalledWith('lease-1');
    expect(coordination.claim.mock.invocationCallOrder[0]).toBeLessThan(
      (api.startScan as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
    );
    expect((api.stopScan as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(
      coordination.release.mock.invocationCallOrder[0]!,
    );
  });

  it.each([
    ['chooser cancel', async () => null],
    [
      'chooser exception',
      async () => {
        throw new Error('picker failed');
      },
    ],
  ])('stops and releases after %s', async (name, selectDevice) => {
    const coordination = makeCoordination();
    __setScannerCoordinationForTests(coordination);
    const api = makeApi();

    const scan = scanAndSelectDevice(api, { selectDevice, scanDurationMs: 100 });
    if (name === 'chooser cancel') await expect(scan).resolves.toBeNull();
    else await expect(scan).rejects.toThrow('picker failed');

    expect(api.stopScan).toHaveBeenCalledOnce();
    expect(coordination.release).toHaveBeenCalledWith('lease-1');
  });

  it('confirms stop and releases after scan start throws', async () => {
    const coordination = makeCoordination();
    __setScannerCoordinationForTests(coordination);
    const api = makeApi({ startScan: vi.fn().mockRejectedValue(new Error('start failed')) });

    await expect(
      scanAndSelectDevice(api, { selectDevice: vi.fn(), scanDurationMs: 100 }),
    ).rejects.toThrow('start failed');

    expect(api.stopScan).toHaveBeenCalledOnce();
    expect(coordination.release).toHaveBeenCalledWith('lease-1');
  });

  it('retains native ownership when plugin scan stop is not confirmed', async () => {
    const coordination = makeCoordination();
    __setScannerCoordinationForTests(coordination);
    const api = makeApi({ stopScan: vi.fn().mockRejectedValue(new Error('stop failed')) });

    await expect(
      scanAndSelectDevice(api, { selectDevice: async () => null, scanDurationMs: 100 }),
    ).rejects.toThrow('stop failed');

    expect(coordination.release).not.toHaveBeenCalled();
  });

  it('fails before plugin scanning when native ownership is unavailable', async () => {
    const coordination = makeCoordination();
    coordination.claim.mockRejectedValue(new Error('scanner in use'));
    __setScannerCoordinationForTests(coordination);
    const api = makeApi();

    await expect(
      scanAndSelectDevice(api, { selectDevice: vi.fn(), scanDurationMs: 100 }),
    ).rejects.toThrow('scanner in use');

    expect(api.startScan).not.toHaveBeenCalled();
    expect(api.stopScan).not.toHaveBeenCalled();
    expect(coordination.release).not.toHaveBeenCalled();
  });

  it('prewarm holds ownership until its timed stop completes', async () => {
    vi.useFakeTimers();
    const coordination = makeCoordination();
    __setScannerCoordinationForTests(coordination);
    const api = makeApi();

    await prewarmDeviceScan(api, { scanDurationMs: 25 });
    expect(coordination.claim).toHaveBeenCalledOnce();
    expect(coordination.release).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(25);
    expect(api.stopScan).toHaveBeenCalledOnce();
    expect(coordination.release).toHaveBeenCalledWith('lease-1');
  });
});
