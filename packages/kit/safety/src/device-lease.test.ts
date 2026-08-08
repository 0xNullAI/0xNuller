import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  currentDeviceLease,
  grantDeviceLease,
  hasDeviceLease,
  registerSafetySession,
  stopAllSafetySessions,
} from './safety-bus.js';

/**
 * 设备控制权的租约。
 *
 * 「切换应用后原应用失去设备控制权」是产品级要求，但它落地成的是一条安全链：
 * 撤权做得不彻底，表现是「切走了但对方还能控制我的设备」；做得太狠（断连）
 * 又会被 autoReconnect 抢回去。这些测试守的是那条窄路。
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
    // 控制权已经不在它手里，但设备可能还在输出——至少要停掉。
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
        // 同步抛错会在 await 之前就炸出去，不包一层就到不了 catch。
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
    // 交出控制权 ≠ 断开设备。停止按钮停的是所有已注册会话，与谁持有租约无关。
    expect(agent.stop).toHaveBeenCalled();
  });
});
