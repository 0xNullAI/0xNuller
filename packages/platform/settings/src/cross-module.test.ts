import { beforeEach, describe, expect, it } from 'vitest';
import { BrowserAppSettingsStore } from '@dg-agent/storage-browser';
import { loadSettings, saveSettings } from '../../../../apps/voice/src/lib/settings';
import { loadDeviceSafety, updateDeviceSafety } from './device-safety';

/**
 * 跨模块的安全设置一致性。
 *
 * 单看每个模块自己的测试，三份实现都是「对」的——它们各自读写各自的键，各自的
 * 往返都通。合并的整个意义在于**跨模块**那一步：用户在 Agent 里把上限调到 30，
 * 切到 Voice 必须还是 30。这条只有把两个模块的存储层放在一起才测得到。
 *
 * 这里直接跨包 import Voice 的设置模块，而不是复制一份它的形状——复制等于又造了
 * 第四份真源，而这个文件的全部意义就是防止那件事。
 */

beforeEach(() => localStorage.clear());

describe('三个模块共享同一份设备安全设置', () => {
  it('Agent 里调的上限，Voice 立刻看到', () => {
    const agent = new BrowserAppSettingsStore();
    const before = agent.load();
    agent.save({ ...before, maxStrengthA: 30, maxColdStartStrength: 5 });

    const voice = loadSettings();
    expect(voice.coyoteSafety.maxStrengthA).toBe(30);
    expect(voice.coyoteSafety.maxColdStartStrength).toBe(5);
  });

  it('Voice 里调的上限，Agent 立刻看到', () => {
    const voice = loadSettings();
    saveSettings({
      ...voice,
      coyoteSafety: {
        ...voice.coyoteSafety,
        maxStrengthA: 20,
        maxStrengthB: 25,
        maxColdStartStrength: 4,
        maxAdjustStep: 3,
      },
    });

    const agent = new BrowserAppSettingsStore().load();
    // 逐个字段都要断言：只测其中一个的话，铺设值时漏掉某一行不会被发现，
    // 而漏掉的那个会静默回到默认值——默认值本身是合理的，很难看出来。
    expect(agent.maxStrengthA).toBe(20);
    expect(agent.maxStrengthB).toBe(25);
    expect(agent.maxColdStartStrength).toBe(4);
    // 字段改名最容易在这里露馅：Agent 叫 maxAdjustStrengthStep，Voice 叫
    // coyoteSafety.maxAdjustStep，规范名是 maxAdjustStep。
    expect(agent.maxAdjustStrengthStep).toBe(3);
  });

  it('负鼠的上限也跨模块一致', () => {
    updateDeviceSafety((prev) => ({ ...prev, maxIntensityA: 22, maxOpossumAdjustStep: 4 }));

    const agent = new BrowserAppSettingsStore().load();
    const voice = loadSettings();
    expect(agent.maxOpossumIntensityA).toBe(22);
    expect(agent.maxOpossumAdjustStep).toBe(4);
    expect(voice.opossumSafety.maxIntensityA).toBe(22);
    expect(voice.opossumSafety.maxAdjustStep).toBe(4);
  });

  it('后台行为跨模块一致', () => {
    const agent = new BrowserAppSettingsStore();
    agent.save({ ...agent.load(), backgroundBehavior: 'keep' });
    // Chat 读的是同一个真源（它的 use-device 直接调 loadDeviceSafety）。
    expect(loadDeviceSafety().backgroundBehavior).toBe('keep');
  });

  it('allow-all 在任何一个模块写入后都不过夜', () => {
    const voice = loadSettings();
    saveSettings({ ...voice, permissionMode: 'allow-all' });
    // Voice 原本是永久落盘的。合并后采用 Agent 的严格语义，否则「危险模式不过夜」
    // 这条保护会因为换了个写入方就静默消失。
    expect(loadDeviceSafety().permissionMode).toBe('confirm');
    expect(new BrowserAppSettingsStore().load().permissionMode).toBe('confirm');
  });
});
