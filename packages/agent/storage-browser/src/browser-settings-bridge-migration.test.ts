// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { SETTINGS_KEY } from './browser-settings-constants.js';
import { BrowserAppSettingsStore } from './browser-settings-store.js';

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

/** Settings saved while the QQ/Telegram message bridge still existed. */
function seedLegacyBridgeSettings(): void {
  localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({
      version: 1,
      temperature: 0.4,
      speechSynthesisEnabled: true,
      bridge: {
        enabled: true,
        qq: {
          enabled: true,
          wsUrl: 'ws://localhost:3001',
          accessToken: 'qq-legacy-token',
          allowUsers: ['10001'],
          allowGroups: [],
          permissionMode: 'allow-all',
        },
        telegram: {
          enabled: false,
          botToken: 'telegram-legacy-token',
          proxyUrl: '',
          allowUsers: [],
          permissionMode: 'confirm',
        },
      },
    }),
  );
}

it('loads settings that still carry the removed bridge block without dropping other settings', () => {
  seedLegacyBridgeSettings();

  const settings = new BrowserAppSettingsStore().load();

  expect(settings.temperature).toBe(0.4);
  expect(settings.speechSynthesisEnabled).toBe(true);
  expect(settings).not.toHaveProperty('bridge');
});

it('drops the removed bridge block and its tokens on the next save', () => {
  seedLegacyBridgeSettings();
  const store = new BrowserAppSettingsStore();

  store.save(store.load());

  const raw = localStorage.getItem(SETTINGS_KEY) ?? '{}';
  expect(JSON.parse(raw)).not.toHaveProperty('bridge');
  expect(raw).not.toContain('legacy-token');
  expect(JSON.parse(raw).temperature).toBe(0.4);
});
