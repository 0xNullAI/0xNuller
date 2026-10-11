import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DEVICE_SAFETY,
  DEVICE_SAFETY_TURN_LIMITS,
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

  // Defaults are the most conservative set, so falling back to them is safe.
  it.each([
    {
      label: '存储被污染时回落默认值而不是抛出',
      raw: '{不是 JSON',
      expected: { maxStrengthA: 50 },
    },
    {
      // Only the broken field falls back; the user-tuned value survives.
      label: '单个字段坏掉只回落那一个，不影响其余',
      raw: JSON.stringify({ ...DEFAULT_DEVICE_SAFETY, maxStrengthA: '不是数字', maxStrengthB: 40 }),
      expected: { maxStrengthA: 50, maxStrengthB: 40 },
    },
    {
      label: '负数被拒绝',
      raw: JSON.stringify({ ...DEFAULT_DEVICE_SAFETY, maxStrengthA: -10 }),
      expected: { maxStrengthA: 50 },
    },
  ])('$label', ({ raw, expected }) => {
    localStorage.setItem('0xnullai.device-safety', raw);
    expect(() => loadDeviceSafety()).not.toThrow();
    expect(loadDeviceSafety()).toMatchObject(expected);
  });

  it('单回合上限是常量：存量与写入都不能放宽，只能更严', () => {
    localStorage.setItem(
      '0xnullai.device-safety',
      JSON.stringify({
        ...DEFAULT_DEVICE_SAFETY,
        maxToolIterations: 32,
        maxBurstCallsPerTurn: 0,
        maxToolCallsPerTurn: '坏值',
      }),
    );
    const loaded = loadDeviceSafety();
    expect(loaded.maxToolIterations).toBe(DEVICE_SAFETY_TURN_LIMITS.maxToolIterations);
    expect(loaded.maxBurstCallsPerTurn).toBe(0);
    expect(loaded.maxToolCallsPerTurn).toBe(DEVICE_SAFETY_TURN_LIMITS.maxToolCallsPerTurn);

    const saved = saveDeviceSafety({ ...DEFAULT_DEVICE_SAFETY, maxVibrateBurstCallsPerTurn: 99 });
    expect(saved.maxVibrateBurstCallsPerTurn).toBe(
      DEVICE_SAFETY_TURN_LIMITS.maxVibrateBurstCallsPerTurn,
    );
    expect(loadDeviceSafety().maxVibrateBurstCallsPerTurn).toBe(
      DEVICE_SAFETY_TURN_LIMITS.maxVibrateBurstCallsPerTurn,
    );
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

    // The check must happen on *read*, not only on write — the user may keep
    // the page open past the five minutes. A missing stamp counts as expired.
    it.each([
      { label: '未到期时仍是 timed', expiresIn: 60_000, expected: 'timed' },
      { label: '到期后回落 confirm', expiresIn: -1, expected: 'confirm' },
      { label: '没有到期戳时按已过期处理', expiresIn: null, expected: 'confirm' },
    ])('$label', ({ expiresIn, expected }) => {
      const s = {
        ...DEFAULT_DEVICE_SAFETY,
        permissionMode: 'timed' as const,
        ...(expiresIn === null ? {} : { permissionModeExpiresAt: Date.now() + expiresIn }),
      };
      expect(effectivePermissionMode(s)).toBe(expected);
    });
  });

  it('切换应用不改变设置——同一个键，谁读都一样', () => {
    updateDeviceSafety((prev) => ({ ...prev, maxStrengthA: 30 }));
    // The primary reason this package exists: cap at 30 in Agent, switch
    // to Chat, and it must not read 50.
    expect(loadDeviceSafety().maxStrengthA).toBe(30);
  });
});
