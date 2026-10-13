/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  backgroundKeepMs,
  backgroundKeepOptions,
  effectiveBackgroundKeepMinutes,
  isBackgroundKeepReady,
  isBackgroundKeepSupported,
  prepareBackgroundKeep,
  setBackgroundKeepSupport,
} from './background-output.js';
import { DEFAULT_DEVICE_SAFETY, loadDeviceSafety, saveDeviceSafety } from './device-safety.js';

beforeEach(() => localStorage.clear());
afterEach(() => setBackgroundKeepSupport({ maxMinutes: 0 }));

function choose(minutes: number) {
  saveDeviceSafety({ ...DEFAULT_DEVICE_SAFETY, backgroundKeepMinutes: minutes });
}

describe('后台保留输出', () => {
  it('默认立即停止', () => {
    setBackgroundKeepSupport({ maxMinutes: 30 });
    expect(loadDeviceSafety().backgroundKeepMinutes).toBe(0);
    expect(backgroundKeepMs()).toBe(0);
  });

  it('外壳声明支持后才生效', () => {
    choose(10);
    expect(isBackgroundKeepSupported()).toBe(false);
    expect(backgroundKeepOptions()).toEqual([0]);
    expect(backgroundKeepMs()).toBe(0);

    setBackgroundKeepSupport({ maxMinutes: 30 });
    expect(backgroundKeepOptions()).toEqual([0, 5, 10, 30]);
    expect(backgroundKeepMs()).toBe(10 * 60_000);
  });

  it('按平台上限截断，只列出允许的时长', () => {
    choose(30);
    setBackgroundKeepSupport({ maxMinutes: 10 });
    expect(backgroundKeepOptions()).toEqual([0, 5, 10]);
    expect(effectiveBackgroundKeepMinutes()).toBe(10);
    expect(backgroundKeepMs()).toBe(10 * 60_000);
  });

  it('平台未就绪（例如未授权通知）时按立即停止处理', async () => {
    choose(5);
    let granted = false;
    const prepare = vi.fn(async () => {
      granted = true;
      return true;
    });
    setBackgroundKeepSupport({ maxMinutes: 10, ready: () => granted, prepare });
    expect(isBackgroundKeepSupported()).toBe(true);
    expect(isBackgroundKeepReady()).toBe(false);
    expect(backgroundKeepMs()).toBe(0);

    await expect(prepareBackgroundKeep()).resolves.toBe(true);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(backgroundKeepMs()).toBe(5 * 60_000);
  });

  it('授权被拒绝或读取失败时保持立即停止', async () => {
    choose(5);
    setBackgroundKeepSupport({ maxMinutes: 10, ready: () => false, prepare: async () => false });
    await expect(prepareBackgroundKeep()).resolves.toBe(false);
    expect(backgroundKeepMs()).toBe(0);

    setBackgroundKeepSupport({
      maxMinutes: 10,
      ready: () => {
        throw new Error('bridge gone');
      },
    });
    expect(backgroundKeepMs()).toBe(0);
  });

  it('平台在隐藏时的决定是唯一来源：不保留就停，保留不超过它给的时长', () => {
    choose(10);
    let decided = 0;
    setBackgroundKeepSupport({ maxMinutes: 10, decideAtHide: () => decided });
    expect(backgroundKeepMs()).toBe(0);

    decided = 4 * 60_000;
    expect(backgroundKeepMs()).toBe(4 * 60_000);

    decided = 60 * 60_000;
    expect(backgroundKeepMs()).toBe(10 * 60_000);

    setBackgroundKeepSupport({
      maxMinutes: 10,
      decideAtHide: () => {
        throw new Error('bridge gone');
      },
    });
    expect(backgroundKeepMs()).toBe(0);
  });

  it('只接受提供的时长，其他值按立即停止保存', () => {
    choose(600);
    expect(loadDeviceSafety().backgroundKeepMinutes).toBe(0);

    localStorage.setItem(
      '0xnullai.device-safety',
      JSON.stringify({ ...DEFAULT_DEVICE_SAFETY, backgroundKeepMinutes: 7 }),
    );
    expect(loadDeviceSafety().backgroundKeepMinutes).toBe(0);
  });
});
