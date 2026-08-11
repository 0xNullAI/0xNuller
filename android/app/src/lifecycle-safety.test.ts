import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceClient, DeviceState } from '@dg-agent/core';
import { wrapWithLifecycleSafety } from './lifecycle-safety';

/**
 * Android lifecycle safety net.
 *
 * This is **the last layer that can be verified off a real device**: whether the
 * OS actually emits these events can only be learned by installing on a phone,
 * but "do we stop the device when the event fires" is fully verifiable here.
 *
 * Why it matters more here than on the browser side: Coyote V3 is
 * state-retentive — when BLE drops or no further B0 packets arrive, the device
 * **stays at the last commanded strength**. In a browser a backgrounded tab's
 * timers keep running (throttled but alive), one B0 every 100ms, so the user
 * comes back, presses stop, and it stops. On Android the WebView is suspended,
 * every timer halts, and the device just keeps running until the user returns
 * to the app or the GATT connection drops on its own.
 *
 * So missing one event here costs "the device keeps outputting after the screen
 * locks".
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

/** Wait one turn so the `void stop()` async chain runs to completion. */
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
    // The stopping flag must be reset after every run, otherwise only the first
    // screen lock stops the device.
    expect(fake.stops()).toBe(2);
  });

  it('设备侧抛错不会让异常逃出去', async () => {
    const boom = fakeClient();
    boom.client.emergencyStop = async () => {
      throw new Error('BLE 已断开');
    };
    const w = wrapWithLifecycleSafety(boom.client);
    boom.setConnected(true);

    // An unhandled promise rejection turns into a global error. The device may
    // already be unreachable anyway, so failures in this direction must be
    // swallowed — the assertion is "no rejection escaped", not "what tick returned".
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

    // This wrapper builds its return value as an explicit object literal
    // (deliberately: spreading a class instance drops prototype methods), so any
    // method not listed there is silently dropped. connectDevice was dropped
    // exactly that way once, and the symptom was that every Coyote connection
    // made through the unified picker failed with 「当前环境不支持连接郊狼设备」.
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
