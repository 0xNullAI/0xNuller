// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import {
  LEGACY_VOICE_API_KEY_LOCAL,
  LEGACY_VOICE_API_KEY_SESSION,
  SETTINGS_KEY,
} from './browser-settings-constants.js';
import { BrowserAppSettingsStore } from './browser-settings-store.js';

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

function seedLegacyDashscopeVoice(): void {
  localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({
      version: 1,
      temperature: 0.4,
      speechSynthesisEnabled: true,
      voice: {
        mode: 'dashscope-proxy',
        speaker: 'longyumi_v2',
        browserVoiceUri: 'voice://zh',
        proxyUrl: 'https://speech-proxy.example',
        autoStopEnabled: false,
      },
    }),
  );
  localStorage.setItem(LEGACY_VOICE_API_KEY_LOCAL, 'sk-dashscope-legacy');
  sessionStorage.setItem(LEGACY_VOICE_API_KEY_SESSION, 'sk-dashscope-session');
}

it('loads a stored DashScope voice mode as browser speech without dropping other settings', () => {
  seedLegacyDashscopeVoice();

  const settings = new BrowserAppSettingsStore().load();

  expect(settings.voice).toEqual({ browserVoiceUri: 'voice://zh' });
  expect(settings.temperature).toBe(0.4);
  expect(settings.speechSynthesisEnabled).toBe(true);
});

it('drops the stored DashScope key and legacy voice fields on the next save', () => {
  seedLegacyDashscopeVoice();
  const store = new BrowserAppSettingsStore();

  store.save(store.load());

  expect(localStorage.getItem(LEGACY_VOICE_API_KEY_LOCAL)).toBeNull();
  expect(sessionStorage.getItem(LEGACY_VOICE_API_KEY_SESSION)).toBeNull();
  const persisted = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as {
    voice?: Record<string, unknown>;
  };
  expect(persisted.voice).toEqual({ browserVoiceUri: 'voice://zh' });
});

it('drops the stored DashScope key on reset', () => {
  seedLegacyDashscopeVoice();

  new BrowserAppSettingsStore().reset();

  expect(localStorage.getItem(LEGACY_VOICE_API_KEY_LOCAL)).toBeNull();
  expect(sessionStorage.getItem(LEGACY_VOICE_API_KEY_SESSION)).toBeNull();
});
