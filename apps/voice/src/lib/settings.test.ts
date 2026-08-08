import { beforeEach, describe, expect, it } from 'vitest';
import { createDefaultSettings, loadSettings, saveSettings, SETTINGS_STORAGE_KEY } from './settings.js';

describe('settings persistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('returns fresh defaults when nothing is stored', () => {
    const settings = loadSettings();
    expect(settings.activeProviderId).toBe('xai');
    expect(settings.permissionMode).toBe('confirm');
    expect(settings.providers.xai.model).toBe('grok-voice-think-fast-1.0');
  });

  it('round-trips a saved settings object', () => {
    const settings = createDefaultSettings();
    settings.activeProviderId = 'openai';
    settings.providers.openai.apiKey = 'sk-test';
    settings.coyoteSafety.maxStrengthA = 30;

    saveSettings(settings);
    const loaded = loadSettings();

    expect(loaded.activeProviderId).toBe('openai');
    expect(loaded.providers.openai.apiKey).toBe('sk-test');
    expect(loaded.coyoteSafety.maxStrengthA).toBe(30);
  });

  it('falls back to defaults instead of throwing on malformed stored JSON', () => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, '{not valid json');
    const settings = loadSettings();
    expect(settings).toEqual(createDefaultSettings());
  });

  it('merges a partial/older-shaped stored object over defaults without crashing', () => {
    // `theme` 是已经移除的字段（主题上提到 @0xnullai/ui 的共享 store）。老用户的
    // 存储里还留着它——多出来的键必须被无视，而不是让整份设置回落默认值。
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ theme: 'dark', activeProviderId: 'zhipu' }),
    );
    const settings = loadSettings();
    expect(settings.activeProviderId).toBe('zhipu');
    expect(settings.coyoteSafety.maxStrengthA).toBe(50);
    expect(settings).not.toHaveProperty('theme');
  });
});
