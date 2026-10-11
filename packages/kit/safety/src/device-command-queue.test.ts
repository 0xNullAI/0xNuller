import { describe, expect, it, vi } from 'vitest';
import type { OpossumClient } from '@dg-kit/protocol';
import { OpossumCommandQueue } from './device-command-queue.js';

describe('OpossumCommandQueue execution receipts', () => {
  it('marks queued and in-flight commands interrupted after emergency stop', async () => {
    let releaseFirst: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let signalStarted: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const execute = vi.fn(async () => {
      signalStarted?.();
      await started;
      return { state: { connected: true } };
    });
    const emergencyStop = vi.fn(async () => undefined);
    const client = {
      execute,
      emergencyStop,
      getState: async () => ({ connected: true }),
    } as unknown as OpossumClient;
    const queue = new OpossumCommandQueue(client);
    const first = queue.enqueue({ type: 'vibrateStop' } as never);
    await entered;
    const queued = queue.enqueue({ type: 'vibrateStop' } as never);
    await queue.emergencyStop();
    releaseFirst?.();

    expect((await first).interrupted).toBe(true);
    expect((await queued).interrupted).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(emergencyStop).toHaveBeenCalledTimes(2);
  });
});
