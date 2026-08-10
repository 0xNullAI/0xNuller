import { describe, expect, it, vi } from 'vitest';
import { runWithGattReadyRetry } from './gatt-ready.js';

describe('runWithGattReadyRetry', () => {
  it('resolves immediately when the first attempt succeeds', async () => {
    const attempt = vi.fn().mockResolvedValue(undefined);
    await runWithGattReadyRetry(attempt, { gattReadyInitialDelayMs: 0 });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('retries on a GATT-not-ready error and eventually succeeds', async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new Error('No services matching UUID 0000180c... found in Device'))
      .mockRejectedValueOnce(new Error('No services matching UUID found'))
      .mockResolvedValueOnce(undefined);

    await runWithGattReadyRetry(attempt, {
      gattReadyInitialDelayMs: 0,
      gattReadyIntervalMs: 0,
      gattReadyTimeoutMs: 1000,
    });

    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('rethrows immediately on a non-transient error without retrying', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('未授予蓝牙权限'));

    await expect(runWithGattReadyRetry(attempt, { gattReadyInitialDelayMs: 0 })).rejects.toThrow(
      '未授予蓝牙权限',
    );
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('gives up once the retry budget is exhausted and rethrows the last error', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('service not found'));

    await expect(
      runWithGattReadyRetry(attempt, {
        gattReadyInitialDelayMs: 0,
        gattReadyIntervalMs: 5,
        gattReadyTimeoutMs: 20,
      }),
    ).rejects.toThrow('service not found');
    expect(attempt.mock.calls.length).toBeGreaterThan(1);
  });

  it('matches error patterns case-insensitively', async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new Error('NO SERVICES MATCHING UUID FOUND'))
      .mockResolvedValueOnce(undefined);

    await runWithGattReadyRetry(attempt, { gattReadyInitialDelayMs: 0, gattReadyIntervalMs: 0 });
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});
