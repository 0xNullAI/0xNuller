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
    // 默认值是最保守的那一组，这个方向的失败是安全的。
    expect(() => loadDeviceSafety()).not.toThrow();
    expect(loadDeviceSafety().maxStrengthA).toBe(50);
  });

  it('单个字段坏掉只回落那一个，不影响其余', () => {
    saveDeviceSafety({ ...DEFAULT_DEVICE_SAFETY, maxStrengthA: 30, maxStrengthB: 40 });
    const raw = JSON.parse(localStorage.getItem('0xnullai.device-safety')!);
    raw.maxStrengthA = '不是数字';
    localStorage.setItem('0xnullai.device-safety', JSON.stringify(raw));

    const s = loadDeviceSafety();
    expect(s.maxStrengthA).toBe(50); // 回落默认
    expect(s.maxStrengthB).toBe(40); // 用户设的值保住了
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
          // 这两个是最容易漏的改名：Agent 叫 maxAdjustStrengthStep / maxOpossumIntensityA，
          // 规范名是 maxAdjustStep / maxIntensityA。漏掉的话用户调过的上限会静默回默认值。
          maxAdjustStrengthStep: 7,
          maxOpossumIntensityA: 25,
          maxOpossumAdjustStep: 6,
          backgroundBehavior: 'keep',
        }),
      );
      const s = loadDeviceSafety();
      expect(s.maxStrengthA).toBe(30);
      expect(s.maxAdjustStep).toBe(7);
      expect(s.maxIntensityA).toBe(25);
      expect(s.maxOpossumAdjustStep).toBe(6);
      expect(s.backgroundBehavior).toBe('keep');
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

    it('Chat 的裸键也认', () => {
      localStorage.setItem('dg-bg-behavior', 'keep');
      expect(loadDeviceSafety().backgroundBehavior).toBe('keep');
    });

    it('一处坏掉不影响其它来源', () => {
      localStorage.setItem('dg-agent.browser-settings', '{坏的');
      localStorage.setItem('dg-bg-behavior', 'keep');
      expect(loadDeviceSafety().backgroundBehavior).toBe('keep');
    });

    it('迁移只发生一次', () => {
      localStorage.setItem('dg-agent.browser-settings', JSON.stringify({ maxStrengthA: 30 }));
      expect(loadDeviceSafety().maxStrengthA).toBe(30);
      localStorage.setItem('dg-agent.browser-settings', JSON.stringify({ maxStrengthA: 99 }));
      expect(loadDeviceSafety().maxStrengthA).toBe(30);
    });
  });

  describe('allow-all 不过夜', () => {
    it('落盘时降级为 confirm', () => {
      saveDeviceSafety({ ...DEFAULT_DEVICE_SAFETY, permissionMode: 'allow-all' });
      // 合并前 Voice 是永久落盘的：刷新后仍然完全放行。采用 Agent 的严格语义，
      // 否则「危险模式不过夜」这条保护会在合并中静默消失。
      expect(loadDeviceSafety().permissionMode).toBe('confirm');
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
      // 判断必须在**读取**时做，不能只在写入时做——用户可能开着页面过了五分钟。
      expect(effectivePermissionMode(s)).toBe('confirm');
    });

    it('没有到期戳时按已过期处理', () => {
      const s = { ...DEFAULT_DEVICE_SAFETY, permissionMode: 'timed' as const };
      expect(effectivePermissionMode(s)).toBe('confirm');
    });
  });

  it('切换应用不改变设置——同一个键，谁读都一样', () => {
    updateDeviceSafety((prev) => ({ ...prev, maxStrengthA: 30 }));
    // 这是这个包存在的首要理由：用户在 Agent 里把上限调到 30，切到 Chat 不该变回 50。
    expect(loadDeviceSafety().maxStrengthA).toBe(30);
  });
});
