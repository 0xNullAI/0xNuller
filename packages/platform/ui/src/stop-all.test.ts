import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSafetySession } from '@dg-kit/safety';
import {
  clearStopFailure,
  stopAllDevices,
  stopFailureLabels,
  subscribeStopFailure,
} from './stop-all';

/**
 * The defect these cover: `stopAllSafetySessions` reports which sessions
 * failed, and every caller threw that away. The stop button went back to
 * reading 停止 while a device was still outputting.
 *
 * So the assertions are about the *reporting*, not about stopping — the bus
 * itself is already tested in @dg-kit/safety.
 */

const cleanups: (() => void)[] = [];

function session(id: string, label: string, stop: () => void | Promise<void>) {
  cleanups.push(
    registerSafetySession({ id, label, isActive: () => true, stop, devices: () => [] }),
  );
}

beforeEach(() => clearStopFailure());

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  clearStopFailure();
});

describe('全部停止的失败上报', () => {
  it('全部停住时不留警告', async () => {
    session('agent', 'Agent', () => undefined);
    session('chat', 'Chat', () => undefined);

    await stopAllDevices();

    expect(stopFailureLabels()).toEqual([]);
  });

  it('某个模块停不下来时，记下它的名字', async () => {
    session('agent', 'Agent', () => {
      throw new Error('BLE 已断开');
    });
    session('chat', 'Chat', () => undefined);

    await stopAllDevices();

    expect(stopFailureLabels()).toEqual(['Agent']);
  });

  it('一个模块抛错不影响其它模块被记为成功', async () => {
    const chatStopped = vi.fn();
    session('agent', 'Agent', () => {
      throw new Error('boom');
    });
    session('chat', 'Chat', chatStopped);

    await stopAllDevices();

    expect(chatStopped).toHaveBeenCalledTimes(1);
    expect(stopFailureLabels()).not.toContain('Chat');
  });

  it('异步 stop 被拒绝时同样记录', async () => {
    session('voice', 'Voice', () => Promise.reject(new Error('timeout')));

    await stopAllDevices();

    expect(stopFailureLabels()).toEqual(['Voice']);
  });

  it('下一次全部成功会清掉上一次的警告', async () => {
    session('agent', 'Agent', () => {
      throw new Error('boom');
    });
    await stopAllDevices();
    expect(stopFailureLabels()).toEqual(['Agent']);

    while (cleanups.length) cleanups.pop()!();
    session('agent', 'Agent', () => undefined);
    await stopAllDevices();

    expect(stopFailureLabels()).toEqual([]);
  });

  it('警告不会自己消失——只有用户能清掉', async () => {
    session('agent', 'Agent', () => {
      throw new Error('boom');
    });
    await stopAllDevices();

    await new Promise((r) => setTimeout(r, 20));
    expect(stopFailureLabels()).toEqual(['Agent']);

    clearStopFailure();
    expect(stopFailureLabels()).toEqual([]);
  });

  it('订阅者会收到失败通知', async () => {
    const seen = vi.fn();
    const unsub = subscribeStopFailure(seen);
    session('agent', 'Agent', () => {
      throw new Error('boom');
    });

    await stopAllDevices();

    expect(seen).toHaveBeenCalled();
    unsub();
  });
});
