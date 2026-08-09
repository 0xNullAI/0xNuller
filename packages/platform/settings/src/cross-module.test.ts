import { beforeEach, describe, expect, it } from 'vitest';
import { BrowserAppSettingsStore } from '@dg-agent/storage-browser';
import { loadSettings, saveSettings } from '../../../../apps/voice/src/lib/settings';
import { loadDeviceSafety, updateDeviceSafety } from './device-safety';

/**
 * Cross-module consistency of safety settings.
 *
 * Judged by each module's own tests, all three implementations were
 * "correct" — each read and wrote its own keys, and each round-trip passed.
 * The whole point of the merge is the *cross-module* step: cap at 30 in
 * Agent, switch to Voice, it must still be 30. Only putting the two storage
 * layers side by side can test that.
 *
 * This file imports Voice's settings module across packages instead of
 * copying its shape — a copy would be a fourth source of truth, and this
 * file exists precisely to prevent that.
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
    // Assert every field: testing just one lets a missed mapping line go
    // unnoticed, and the missed field silently reverts to its default —
    // hard to spot because the default itself is reasonable.
    expect(agent.maxStrengthA).toBe(20);
    expect(agent.maxStrengthB).toBe(25);
    expect(agent.maxColdStartStrength).toBe(4);
    // Renames surface here first: Agent says maxAdjustStrengthStep, Voice
    // says coyoteSafety.maxAdjustStep, canonical is maxAdjustStep.
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
    // Chat reads the same source of truth (its use-device calls
    // loadDeviceSafety directly).
    expect(loadDeviceSafety().backgroundBehavior).toBe('keep');
  });

  it('allow-all 在任何一个模块写入后都不过夜', () => {
    const voice = loadSettings();
    saveSettings({ ...voice, permissionMode: 'allow-all' });
    // Voice used to persist it permanently. Post-merge we adopt Agent's
    // strict semantics, or the "dangerous mode does not survive overnight"
    // guarantee silently disappears just because a different module wrote
    // the value.
    expect(loadDeviceSafety().permissionMode).toBe('confirm');
    expect(new BrowserAppSettingsStore().load().permissionMode).toBe('confirm');
  });
});
