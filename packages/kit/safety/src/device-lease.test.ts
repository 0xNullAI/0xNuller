import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  currentDeviceLease,
  grantDeviceLease,
  hasDeviceLease,
  registerSafetySession,
  stopAllSafetySessions,
} from './safety-bus.js';

/**
 * The device-control lease.
 *
 * "Switching modules revokes the previous module's device control" is a
 * product requirement, but it lands as a safety chain: revoke too little and
 * the symptom is "I switched away but they can still control my device";
 * revoke too hard (disconnect) and autoReconnect steals the device back.
 * These tests guard that narrow path.
 */

const cleanups: (() => void)[] = [];

function session(id: string, over: Partial<Parameters<typeof registerSafetySession>[0]> = {}) {
  const stop = vi.fn();
  const onRevoke = vi.fn();
  cleanups.push(
    registerSafetySession({
      id,
      label: id,
      isActive: () => true,
      stop,
      onRevoke,
      ...over,
    }),
  );
  return { stop, onRevoke };
}

beforeEach(async () => {
  while (cleanups.length) cleanups.pop()!();
  await grantDeviceLease(null);
});

describe('设备控制权租约', () => {
  it('默认没有任何模块持有', () => {
    session('agent');
    expect(currentDeviceLease()).toBeNull();
    expect(hasDeviceLease('agent')).toBe(false);
  });

  it('授予后只有那一个模块持有', async () => {
    session('agent');
    session('chat');
    await grantDeviceLease('agent');
    expect(hasDeviceLease('agent')).toBe(true);
    expect(hasDeviceLease('chat')).toBe(false);
  });

  it('转移时通知失去的一方', async () => {
    const agent = session('agent');
    session('chat');
    await grantDeviceLease('agent');
    await grantDeviceLease('chat');
    expect(agent.onRevoke).toHaveBeenCalledTimes(1);
  });

  it('重复授予同一个不会重复撤权', async () => {
    const agent = session('agent');
    await grantDeviceLease('agent');
    await grantDeviceLease('agent');
    expect(agent.onRevoke).not.toHaveBeenCalled();
  });

  it('交回 null 时也撤权——停在首页等于没人能下指令', async () => {
    const agent = session('agent');
    await grantDeviceLease('agent');
    await grantDeviceLease(null);
    expect(agent.onRevoke).toHaveBeenCalledTimes(1);
    expect(currentDeviceLease()).toBeNull();
  });

  it('onRevoke 抛错时回落到 stop()', async () => {
    const stop = vi.fn();
    cleanups.push(
      registerSafetySession({
        id: 'agent',
        label: 'agent',
        isActive: () => true,
        stop,
        onRevoke: () => {
          throw new Error('撤权失败');
        },
      }),
    );
    await grantDeviceLease('agent');
    await grantDeviceLease('chat');
    // It no longer holds the lease, but its device may still be outputting
    // — at minimum it must be stopped.
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('onRevoke 同步抛错也能被接住', async () => {
    const stop = vi.fn();
    cleanups.push(
      registerSafetySession({
        id: 'agent',
        label: 'agent',
        isActive: () => true,
        stop,
        // A synchronous throw escapes before the await; without the wrapper
        // it never reaches the catch.
        onRevoke: () => {
          throw new Error('同步炸');
        },
      }),
    );
    await grantDeviceLease('agent');
    await expect(grantDeviceLease('chat')).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('没有 onRevoke 的模块不会因此报错', async () => {
    cleanups.push(
      registerSafetySession({ id: 'legacy', label: 'legacy', isActive: () => true, stop: vi.fn() }),
    );
    await grantDeviceLease('legacy');
    await expect(grantDeviceLease('other')).resolves.toBeUndefined();
  });

  it('失去控制权不影响全局停止——设备还连着，停止必须仍然可达', async () => {
    const agent = session('agent');
    await grantDeviceLease('agent');
    await grantDeviceLease(null);

    await stopAllSafetySessions();
    // Surrendering the lease != disconnecting. The stop button stops every
    // registered session regardless of who holds the lease.
    expect(agent.stop).toHaveBeenCalled();
  });
});
