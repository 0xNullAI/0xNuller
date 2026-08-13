import { describe, expect, it, vi } from 'vitest';
import { retry } from './retry.mjs';

describe('retry', () => {
  it('returns immediately after a successful attempt', async () => {
    const operation = vi.fn().mockResolvedValue('ok');

    await expect(retry(operation, { attempts: 3 })).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure and reports it', async () => {
    const transient = new Error('stale deployment');
    const operation = vi.fn().mockRejectedValueOnce(transient).mockResolvedValue('fresh');
    const onRetry = vi.fn();

    await expect(retry(operation, { attempts: 3, onRetry })).resolves.toBe('fresh');
    expect(operation).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(transient, 1, 3);
  });

  it('throws the final error after exhausting the limit', async () => {
    const finalError = new Error('still stale');
    const operation = vi.fn().mockRejectedValue(finalError);

    await expect(retry(operation, { attempts: 2 })).rejects.toBe(finalError);
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
