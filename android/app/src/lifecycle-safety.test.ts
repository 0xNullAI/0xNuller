import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceClient, DeviceState } from '@dg-agent/core';
import { wrapWithLifecycleSafety } from './lifecycle-safety';

/**
 * 安卓生命周期安全网。
 *
 * 这是**真机之外能验到的最后一层**：操作系统真的会不会发出这些事件，只有装到手机上
 * 才知道；但「事件发生时我们是否停下设备」在这里可以完整验证。
 *
 * 为什么它比浏览器端更要紧：郊狼 V3 是状态保持的——BLE 断开或者不再收到 B0 包时，
 * 设备会**保持在最后一次下发的强度上**。浏览器里后台标签页的定时器还在跑（被节流但
 * 活着），每 100ms 一个 B0，用户回来一按停止就停了。安卓上 WebView 被挂起，定时器
 * 全停，设备就那样一直跑着，直到用户回到应用或者 GATT 连接自己掉线。
 *
 * 所以这里漏一个事件，代价是「锁屏之后设备一直在输出」。
 */

function fakeClient(): {
  client: DeviceClient;
  stops: () => number;
  setConnected: (v: boolean) => void;
} {
  let stops = 0;
  let listener: ((s: DeviceState) => void) | null = null;
  const state = { connected: false } as DeviceState;

  const client: DeviceClient = {
    connect: async () => undefined,
    disconnect: async () => undefined,
    getState: async () => state,
    execute: async () => ({ state, notes: [] }),
    emergencyStop: async () => {
      stops += 1;
    },
    onStateChanged: (l) => {
      listener = l;
      return () => {
        listener = null;
      };
    },
  };

  return {
    client,
    stops: () => stops,
    setConnected: (v) => {
      state.connected = v;
      listener?.(state);
    },
  };
}

/** 等一轮微任务，让 `void stop()` 的异步链跑完。 */
const tick = () => new Promise((r) => setTimeout(r, 0));

let fake: ReturnType<typeof fakeClient>;
let wrapped: ReturnType<typeof wrapWithLifecycleSafety>;

beforeEach(() => {
  fake = fakeClient();
  wrapped = wrapWithLifecycleSafety(fake.client);
  fake.setConnected(true);
});

afterEach(async () => {
  await wrapped.disconnect();
  vi.restoreAllMocks();
});

function hide() {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('安卓生命周期安全网', () => {
  it('页面隐藏时停止输出', async () => {
    hide();
    await tick();
    expect(fake.stops()).toBe(1);
  });

  it('pagehide 也停——WebView 被系统回收时可能只走这一个', async () => {
    window.dispatchEvent(new Event('pagehide'));
    await tick();
    expect(fake.stops()).toBe(1);
  });

  it('freeze 也停——Chromium 的 bfcache 驱逐走这个', async () => {
    document.dispatchEvent(new Event('freeze'));
    await tick();
    expect(fake.stops()).toBe(1);
  });

  it('页面变可见不会触发停止', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await tick();
    expect(fake.stops()).toBe(0);
  });

  it('未连接时不停——连接进行中触发急停会写进半初始化的协议状态', async () => {
    fake.setConnected(false);
    hide();
    await tick();
    expect(fake.stops()).toBe(0);
  });

  it('切走再切回来再切走，第二次仍然停', async () => {
    hide();
    await tick();
    vi.restoreAllMocks();

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await tick();

    hide();
    await tick();
    // stopping 标志必须在每次结束后复位，否则只有第一次锁屏会停。
    expect(fake.stops()).toBe(2);
  });

  it('设备侧抛错不会让异常逃出去', async () => {
    const boom = fakeClient();
    boom.client.emergencyStop = async () => {
      throw new Error('BLE 已断开');
    };
    const w = wrapWithLifecycleSafety(boom.client);
    boom.setConnected(true);

    // 未捕获的 Promise 拒绝会变成全局错误。设备本来就可能已经不可达，
    // 这个方向的失败必须被吞掉——断言的是「没有拒绝逃出去」，不是「tick 返回了什么」。
    const rejections: unknown[] = [];
    const onRejection = (e: PromiseRejectionEvent) => rejections.push(e.reason);
    window.addEventListener('unhandledrejection', onRejection);

    hide();
    await tick();
    await tick();

    window.removeEventListener('unhandledrejection', onRejection);
    expect(rejections).toEqual([]);
    await w.disconnect();
  });

  it('disconnect 之后不再响应生命周期事件', async () => {
    await wrapped.disconnect();
    hide();
    await tick();
    expect(fake.stops()).toBe(0);
  });

  it('转发 connectDevice——它不在 DeviceClient 接口里，漏掉会让统一选择器连不上郊狼', async () => {
    const connectDevice = vi.fn().mockResolvedValue(undefined);
    const withExtra = Object.assign(fakeClient().client, { connectDevice });
    const w = wrapWithLifecycleSafety(withExtra);

    // 这个包装用显式对象字面量构造返回值（刻意的：展开类实例会丢原型方法），
    // 所以没列进去的方法会被静默丢掉。connectDevice 就曾经这样丢过，表现是
    // 每一次通过统一选择器连郊狼都报「当前环境不支持连接郊狼设备」。
    expect(typeof w.connectDevice).toBe('function');
    await w.connectDevice?.({} as never, {} as never);
    expect(connectDevice).toHaveBeenCalled();
  });

  it('其余方法透明转发', async () => {
    const inner = fakeClient().client;
    const execute = vi.fn().mockResolvedValue({ state: {}, notes: [] });
    inner.execute = execute;
    const w = wrapWithLifecycleSafety(inner);

    await w.execute({ type: 'stop', channel: 'A' } as never);
    expect(execute).toHaveBeenCalled();
  });
});
