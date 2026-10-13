/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backgroundKeepMs, setBackgroundKeepSupported } from './background-output.js';
import { DEFAULT_DEVICE_SAFETY, loadDeviceSafety, saveDeviceSafety } from './device-safety.js';

beforeEach(() => localStorage.clear());
afterEach(() => setBackgroundKeepSupported(false));

describe('后台保留输出', () => {
  it('默认立即停止', () => {
    setBackgroundKeepSupported(true);
    expect(loadDeviceSafety().backgroundKeepMinutes).toBe(0);
    expect(backgroundKeepMs()).toBe(0);
  });

  it('外壳声明支持后才生效', () => {
    saveDeviceSafety({ ...DEFAULT_DEVICE_SAFETY, backgroundKeepMinutes: 10 });
    expect(backgroundKeepMs()).toBe(0);

    setBackgroundKeepSupported(true);
    expect(backgroundKeepMs()).toBe(10 * 60_000);
  });

  it('只接受提供的时长，其他值按立即停止保存', () => {
    saveDeviceSafety({ ...DEFAULT_DEVICE_SAFETY, backgroundKeepMinutes: 600 });
    expect(loadDeviceSafety().backgroundKeepMinutes).toBe(0);

    localStorage.setItem(
      '0xnullai.device-safety',
      JSON.stringify({ ...DEFAULT_DEVICE_SAFETY, backgroundKeepMinutes: 7 }),
    );
    expect(loadDeviceSafety().backgroundKeepMinutes).toBe(0);
  });
});
