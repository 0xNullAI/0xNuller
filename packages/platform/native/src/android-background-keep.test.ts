/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DgLabDeviceSnapshot } from '@0xnullai/device-runtime';
import { DEFAULT_DEVICE_SAFETY, saveDeviceSafety } from '@0xnullai/settings';
import {
  androidBackgroundKeepBridge,
  installAndroidBackgroundKeep,
  isDgLabOutputActive,
  readNativeOutputStopped,
  readNativePause,
  requestNotificationPermission,
  type AndroidBackgroundKeepBridge,
} from './android-background-keep';

function fakeBridge(overrides: Partial<AndroidBackgroundKeepBridge> = {}) {
  let permission = 'granted';
  const bridge = {
    getBackgroundKeepCapability: vi.fn(() => 1),
    getNotificationPermissionStatus: vi.fn(() => permission),
    requestNotificationPermission: vi.fn(() => {
      permission = 'requesting';
    }),
    setBackgroundKeep: vi.fn(() => true),
    getBackgroundKeepUntil: vi.fn(() => 0),
    ...overrides,
  };
  return {
    bridge,
    setPermission(next: string) {
      permission = next;
    },
  };
}

function coyote(strengthA: number, connected = true): DgLabDeviceSnapshot {
  return {
    id: 'coyote/1',
    stableKey: 'coyote:1',
    name: '郊狼',
    connected,
    kind: 'coyote',
    state: { strengthA, strengthB: 0 },
    limits: { a: 50, b: 50 },
  } as unknown as DgLabDeviceSnapshot;
}

function fakeRegistry(devices: DgLabDeviceSnapshot[] = []) {
  const listeners = new Set<() => void>();
  return {
    devices,
    list: () => devices,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(next: DgLabDeviceSnapshot[]) {
      devices = next;
      for (const listener of listeners) listener();
    },
  };
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('原生后台保持桥的特性检测', () => {
  it('旧 APK（缺方法或版本过低）视为不支持', () => {
    expect(androidBackgroundKeepBridge(undefined)).toBeNull();
    expect(androidBackgroundKeepBridge({ getSdkInt: () => 34 })).toBeNull();
    const { bridge } = fakeBridge({ getBackgroundKeepCapability: () => 0 });
    expect(androidBackgroundKeepBridge(bridge)).toBeNull();
    const throwing = fakeBridge({
      getBackgroundKeepCapability: () => {
        throw new Error('gone');
      },
    });
    expect(androidBackgroundKeepBridge(throwing.bridge)).toBeNull();
  });

  it('完整的桥被识别', () => {
    const { bridge } = fakeBridge();
    expect(androidBackgroundKeepBridge(bridge)).toBe(bridge);
  });

  it('没有原生桥时不支持后台保持', () => {
    const support = installAndroidBackgroundKeep(fakeRegistry(), { bridge: null });
    expect(support.maxMinutes).toBe(0);
  });
});

describe('通知权限', () => {
  const wait = () => Promise.resolve();

  it('已授权直接返回，不弹系统框', async () => {
    const { bridge } = fakeBridge();
    await expect(requestNotificationPermission(bridge, { wait })).resolves.toBe(true);
    expect(bridge.requestNotificationPermission).not.toHaveBeenCalled();
  });

  it('请求后等待用户选择', async () => {
    const fake = fakeBridge();
    fake.setPermission('prompt');
    let polls = 0;
    const result = requestNotificationPermission(fake.bridge, {
      wait: async () => {
        polls += 1;
        if (polls === 2) fake.setPermission('granted');
      },
    });
    await expect(result).resolves.toBe(true);
    expect(fake.bridge.requestNotificationPermission).toHaveBeenCalledTimes(1);
  });

  it('拒绝或已被永久拒绝时返回 false', async () => {
    const denied = fakeBridge();
    denied.setPermission('prompt');
    denied.bridge.requestNotificationPermission.mockImplementation(() =>
      denied.setPermission('denied'),
    );
    await expect(requestNotificationPermission(denied.bridge, { wait })).resolves.toBe(false);

    const blocked = fakeBridge();
    blocked.setPermission('blocked');
    await expect(requestNotificationPermission(blocked.bridge, { wait })).resolves.toBe(false);
    expect(blocked.bridge.requestNotificationPermission).not.toHaveBeenCalled();
  });
});

describe('事件解析', () => {
  it('native-pause 只在 kept 为 true 且有截止时间时算保留', () => {
    const pause = (detail: unknown) =>
      readNativePause(new CustomEvent('0xnullai:native-pause', { detail }));
    expect(pause({ kept: true, until: 5, at: 1 })).toEqual({ kept: true, until: 5, at: 1 });
    expect(pause({ kept: true, until: 0 })).toEqual({ kept: false, until: 0 });
    expect(pause({ kept: 'true', until: 5 })).toEqual({ kept: false, until: 0 });
    expect(pause(undefined)).toEqual({ kept: false, until: 0 });
  });

  it('native-output-stopped：到时是 background-timeout，其余是 background', () => {
    const stopped = (detail: unknown) =>
      readNativeOutputStopped(new CustomEvent('0xnullai:native-output-stopped', { detail }));
    expect(stopped({ reason: 'timeout', at: 3 })).toEqual({ reason: 'background-timeout', at: 3 });
    expect(stopped({ reason: 'emergency' })).toEqual({ reason: 'background' });
    expect(stopped(null)).toEqual({ reason: 'background' });
  });

  it('只有已连接且非零的郊狼或负鼠算输出中', () => {
    expect(isDgLabOutputActive([coyote(0)])).toBe(false);
    expect(isDgLabOutputActive([coyote(5, false)])).toBe(false);
    expect(isDgLabOutputActive([coyote(5)])).toBe(true);
  });
});

describe('向原生服务同步状态', () => {
  it('设置、权限与输出状态变化时同步，状态不变不重复调用', () => {
    const { bridge } = fakeBridge();
    const registry = fakeRegistry([coyote(0)]);
    installAndroidBackgroundKeep(registry, { bridge });
    expect(bridge.setBackgroundKeep).toHaveBeenLastCalledWith(false, 0, false);

    saveDeviceSafety({ ...DEFAULT_DEVICE_SAFETY, backgroundKeepMinutes: 30 });
    // Android caps at 10 minutes.
    expect(bridge.setBackgroundKeep).toHaveBeenLastCalledWith(true, 600_000, false);

    registry.emit([coyote(8)]);
    expect(bridge.setBackgroundKeep).toHaveBeenLastCalledWith(true, 600_000, true);
    const calls = bridge.setBackgroundKeep.mock.calls.length;
    registry.emit([coyote(9)]);
    expect(bridge.setBackgroundKeep.mock.calls.length).toBe(calls);
  });

  it('未授权通知时不武装保持', () => {
    const fake = fakeBridge();
    fake.setPermission('denied');
    saveDeviceSafety({ ...DEFAULT_DEVICE_SAFETY, backgroundKeepMinutes: 5 });
    const support = installAndroidBackgroundKeep(fakeRegistry([coyote(8)]), {
      bridge: fake.bridge,
    });
    expect(fake.bridge.setBackgroundKeep).toHaveBeenLastCalledWith(false, 0, true);
    expect(support.maxMinutes).toBe(10);
    expect(support.ready?.()).toBe(false);
  });

  it('隐藏时的决定来自原生 onPause 记录的截止时间', () => {
    let until = 0;
    const { bridge } = fakeBridge({ getBackgroundKeepUntil: () => until });
    const support = installAndroidBackgroundKeep(fakeRegistry(), { bridge, now: () => 1_000 });
    expect(support.decideAtHide?.()).toBe(0);
    until = 61_000;
    expect(support.decideAtHide?.()).toBe(60_000);
    until = 500;
    expect(support.decideAtHide?.()).toBe(0);
  });
});
