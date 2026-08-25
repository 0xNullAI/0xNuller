import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DEVICE_SAFETY,
  effectivePermissionMode,
  loadDeviceSafety,
  saveDeviceSafety,
  updateDeviceSafety,
} from './device-safety';

beforeEach(() => {
  localStorage.clear();
  vi.useRealTimers();
});

describe('共享设备安全设置', () => {
  it('没有任何记录时用默认值', () => {
    expect(loadDeviceSafety()).toEqual(DEFAULT_DEVICE_SAFETY);
  });

  it('存储被污染时回落默认值而不是抛出', () => {
    localStorage.setItem('0xnullai.device-safety', '{不是 JSON');
    // Defaults are the most conservative set; failing this way is safe.
    expect(() => loadDeviceSafety()).not.toThrow();
    expect(loadDeviceSafety().maxStrengthA).toBe(50);
  });

  it('单个字段坏掉只回落那一个，不影响其余', () => {
    saveDeviceSafety({ ...DEFAULT_DEVICE_SAFETY, maxStrengthA: 30, maxStrengthB: 40 });
    const raw = JSON.parse(localStorage.getItem('0xnullai.device-safety')!);
    raw.maxStrengthA = '不是数字';
    localStorage.setItem('0xnullai.device-safety', JSON.stringify(raw));

    const s = loadDeviceSafety();
    expect(s.maxStrengthA).toBe(50); // fell back to default
    expect(s.maxStrengthB).toBe(40); // user-tuned value survived
  });

  it('负数被拒绝', () => {
    localStorage.setItem(
      '0xnullai.device-safety',
      JSON.stringify({ ...DEFAULT_DEVICE_SAFETY, maxStrengthA: -10 }),
    );
    expect(loadDeviceSafety().maxStrengthA).toBe(50);
  });

  describe('从三处存量迁移', () => {
    it('Agent 的字段名映射到规范名', () => {
      localStorage.setItem(
        'dg-agent.browser-settings',
        JSON.stringify({
          maxStrengthA: 30,
          maxStrengthB: 35,
          // The two renames easiest to miss: Agent calls them
          // maxAdjustStrengthStep / maxOpossumIntensityA; canonical names
          // are maxAdjustStep / maxIntensityA. Missing them silently resets
          // user-tuned caps to defaults.
          maxAdjustStrengthStep: 7,
          maxOpossumIntensityA: 25,
          maxOpossumAdjustStep: 6,
        }),
      );
      const s = loadDeviceSafety();
      expect(s.maxStrengthA).toBe(30);
      expect(s.maxAdjustStep).toBe(7);
      expect(s.maxIntensityA).toBe(25);
      expect(s.maxOpossumAdjustStep).toBe(6);
    });

    it('Voice 的嵌套字段也认', () => {
      localStorage.setItem(
        'dg-voice-settings',
        JSON.stringify({
          coyoteSafety: { maxBurstDurationMs: 3000 },
          opossumSafety: { maxColdStartIntensity: 5, maxAdjustStep: 8 },
        }),
      );
      const s = loadDeviceSafety();
      expect(s.maxBurstDurationMs).toBe(3000);
      expect(s.maxColdStartIntensity).toBe(5);
      expect(s.maxOpossumAdjustStep).toBe(8);
    });

    it('迁移只发生一次', () => {
      localStorage.setItem('dg-agent.browser-settings', JSON.stringify({ maxStrengthA: 30 }));
      expect(loadDeviceSafety().maxStrengthA).toBe(30);
      localStorage.setItem('dg-agent.browser-settings', JSON.stringify({ maxStrengthA: 99 }));
      expect(loadDeviceSafety().maxStrengthA).toBe(30);
    });
  });

  describe('allow-all 不过夜', () => {
    it('当前页面保持 allow-all，但落盘降级为 confirm', () => {
      saveDeviceSafety({ ...DEFAULT_DEVICE_SAFETY, permissionMode: 'allow-all' });

      expect(loadDeviceSafety().permissionMode).toBe('allow-all');
      const persisted = JSON.parse(localStorage.getItem('0xnullai.device-safety')!);
      expect(persisted.permissionMode).toBe('confirm');
    });

    it('从 Agent 迁移时同样降级', () => {
      localStorage.setItem(
        'dg-agent.browser-settings',
        JSON.stringify({ permissionMode: 'allow-all' }),
      );
      expect(loadDeviceSafety().permissionMode).toBe('confirm');
    });
  });

  describe('timed 模式到期', () => {
    it('写入时自动补五分钟到期时间', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const saved = saveDeviceSafety({
        ...DEFAULT_DEVICE_SAFETY,
        permissionMode: 'timed',
      });
      expect(saved.permissionModeExpiresAt).toBe(Date.now() + 5 * 60 * 1000);
    });

    it('未到期时仍是 timed', () => {
      const s = {
        ...DEFAULT_DEVICE_SAFETY,
        permissionMode: 'timed' as const,
        permissionModeExpiresAt: Date.now() + 60_000,
      };
      expect(effectivePermissionMode(s)).toBe('timed');
    });

    it('到期后回落 confirm', () => {
      const s = {
        ...DEFAULT_DEVICE_SAFETY,
        permissionMode: 'timed' as const,
        permissionModeExpiresAt: Date.now() - 1,
      };
      // The check must happen on *read*, not only on write — the user may
      // keep the page open past the five minutes.
      expect(effectivePermissionMode(s)).toBe('confirm');
    });

    it('没有到期戳时按已过期处理', () => {
      const s = { ...DEFAULT_DEVICE_SAFETY, permissionMode: 'timed' as const };
      expect(effectivePermissionMode(s)).toBe('confirm');
    });
  });

  it('切换应用不改变设置——同一个键，谁读都一样', () => {
    updateDeviceSafety((prev) => ({ ...prev, maxStrengthA: 30 }));
    // The primary reason this package exists: cap at 30 in Agent, switch
    // to Chat, and it must not read 50.
    expect(loadDeviceSafety().maxStrengthA).toBe(30);
  });
});
