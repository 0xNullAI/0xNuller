import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceClient, DeviceState } from '@dg-agent/core';
import {
  attachAndroidDgLabLifecycle,
  wrapWithLifecycleSafety,
  type DgLabLifecycleStop,
} from './lifecycle-safety';

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
  it.each([
    ['visibilitychange: 页面隐藏', hide],
    [
      'pagehide: WebView 被系统回收时可能只走这一个',
      () => window.dispatchEvent(new Event('pagehide')),
    ],
    ['freeze: Chromium 的 bfcache 驱逐走这个', () => document.dispatchEvent(new Event('freeze'))],
    [
      'native-pause: 原生 onPause 在 WebView 暂停前通知',
      () => window.dispatchEvent(new Event('0xnullai:native-pause')),
    ],
  ])('%s 时停止输出', async (_reason, fire) => {
    fire();
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

function nativePause(detail?: unknown) {
  window.dispatchEvent(new CustomEvent('0xnullai:native-pause', { detail }));
}

function nativeStopped(detail: unknown) {
  window.dispatchEvent(new CustomEvent('0xnullai:native-output-stopped', { detail }));
}

describe('后台保持（单一决定来源）', () => {
  let kept: boolean;
  let keptClient: ReturnType<typeof fakeClient>;
  let keptWrapped: ReturnType<typeof wrapWithLifecycleSafety>;

  beforeEach(async () => {
    // The default wrapper from the outer beforeEach never keeps; detach it for these cases.
    await wrapped.disconnect();
    kept = true;
    keptClient = fakeClient();
    keptWrapped = wrapWithLifecycleSafety(keptClient.client, { keepInBackground: () => kept });
    keptClient.setConnected(true);
  });

  afterEach(async () => {
    await keptWrapped.disconnect();
  });

  it('原生侧决定保留时，隐藏与 native-pause 都不停', async () => {
    hide();
    nativePause({ kept: true, until: Date.now() + 60_000, at: Date.now() });
    await tick();
    expect(keptClient.stops()).toBe(0);
  });

  it('native-pause 说不保留时停止', async () => {
    nativePause({ kept: false, until: 0 });
    await tick();
    expect(keptClient.stops()).toBe(1);
  });

  it('原生侧说保留但共享决定说不保留：两边不一致就停', async () => {
    kept = false;
    nativePause({ kept: true, until: Date.now() + 60_000 });
    await tick();
    expect(keptClient.stops()).toBe(1);
  });

  it('格式不对的 native-pause 按不保留处理', async () => {
    nativePause({ kept: 'yes' });
    await tick();
    expect(keptClient.stops()).toBe(1);
  });

  it('决定读取失败时按停止处理', async () => {
    await keptWrapped.disconnect();
    keptClient = fakeClient();
    keptWrapped = wrapWithLifecycleSafety(keptClient.client, {
      keepInBackground: () => {
        throw new Error('bridge gone');
      },
    });
    keptClient.setConnected(true);
    hide();
    await tick();
    expect(keptClient.stops()).toBe(1);
  });

  it.each([
    ['pagehide', () => window.dispatchEvent(new Event('pagehide'))],
    ['freeze', () => document.dispatchEvent(new Event('freeze'))],
    ['native-output-stopped', () => nativeStopped({ reason: 'emergency', at: 1 })],
  ])('保留中 %s 仍然停止', async (_name, fire) => {
    hide();
    fire();
    await tick();
    expect(keptClient.stops()).toBe(1);
  });
});

describe('注册表层的安卓生命周期', () => {
  type Bridge = {
    getBackgroundKeepCapability: () => number;
    getNotificationPermissionStatus: () => string;
    requestNotificationPermission: () => void;
    setBackgroundKeep: ReturnType<typeof vi.fn>;
    getBackgroundKeepUntil: () => number;
  };
  let detach: () => void;
  let stop: ReturnType<typeof vi.fn<DgLabLifecycleStop>>;
  let kept: boolean;
  let bridge: Bridge;

  beforeEach(async () => {
    kept = true;
    stop = vi.fn<DgLabLifecycleStop>();
    bridge = {
      getBackgroundKeepCapability: () => 1,
      getNotificationPermissionStatus: () => 'granted',
      requestNotificationPermission: () => undefined,
      setBackgroundKeep: vi.fn(() => false),
      getBackgroundKeepUntil: () => 0,
    };
    (window as unknown as { AndroidSystem?: unknown }).AndroidSystem = bridge;
    detach = await attachAndroidDgLabLifecycle(stop, { keepInBackground: () => kept });
  });

  afterEach(() => {
    detach();
    delete (window as unknown as { AndroidSystem?: unknown }).AndroidSystem;
  });

  it('保留时隐藏不停，也不解除原生保持', () => {
    hide();
    nativePause({ kept: true, until: Date.now() + 60_000, at: 7 });
    expect(stop).not.toHaveBeenCalled();
    expect(bridge.setBackgroundKeep).not.toHaveBeenCalled();
  });

  it('不保留时停止并同时解除原生保持', () => {
    nativePause({ kept: false, until: 0, at: 7 });
    expect(stop).toHaveBeenCalledWith('background', 7);
    expect(bridge.setBackgroundKeep).toHaveBeenCalledWith(false, 0, false);
  });

  it('pagehide 总是停止', () => {
    hide();
    window.dispatchEvent(new Event('pagehide'));
    expect(stop).toHaveBeenCalledWith('background', undefined);
    expect(bridge.setBackgroundKeep).toHaveBeenCalledWith(false, 0, false);
  });

  it('原生到时停止按 background-timeout 记录，其他原生停止按 background', () => {
    nativeStopped({ reason: 'timeout', at: 11 });
    expect(stop).toHaveBeenLastCalledWith('background-timeout', 11);
    nativeStopped({ reason: 'emergency', at: 12 });
    expect(stop).toHaveBeenLastCalledWith('background', 12);
    // The native side already stopped and disarmed itself.
    expect(bridge.setBackgroundKeep).not.toHaveBeenCalled();
  });
});
