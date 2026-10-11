// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { API_KEYS_LOCAL, SETTINGS_KEY } from './browser-settings-constants.js';
import {
  migrateApiKeys,
  migratePersistedProviders,
} from './browser-settings-provider-migration.js';
import { BrowserAppSettingsStore } from './browser-settings-store.js';

const persisted = (providerId: string, baseUrl = '') => ({
  providerId,
  baseUrl,
  model: `${providerId}-model`,
  endpoint: 'chat/completions' as const,
  useStrict: false,
});

afterEach(() => localStorage.clear());

describe('migratePersistedProviders', () => {
  it('moves the active removed provider to custom and drops inactive removed ones', () => {
    const result = migratePersistedProviders(persisted('qwen'), {
      qwen: persisted('qwen'),
      anthropic: persisted('anthropic'),
      managed: persisted('managed'),
    });
    expect(result.customKeySource).toBe('qwen');
    expect(result.provider).toMatchObject({
      providerId: 'custom',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-model',
      imageInput: false,
    });
    expect(Object.keys(result.providerConfigs ?? {}).sort()).toEqual(['custom', 'managed']);
  });

  it('returns an unmappable active provider to managed', () => {
    const result = migratePersistedProviders(persisted('minimax'), undefined);
    expect(result.provider?.providerId).toBe('managed');
    expect(result.customKeySource).toBeUndefined();
  });
});

describe('migrateApiKeys', () => {
  it('gives custom the migrated provider key and discards other removed keys', () => {
    expect(migrateApiKeys({ qwen: 'sk-q', anthropic: 'sk-a', custom: 'sk-old' }, 'qwen')).toEqual({
      custom: 'sk-q',
    });
    expect(migrateApiKeys({ anthropic: 'sk-a', custom: 'sk-c' }, undefined)).toEqual({
      custom: 'sk-c',
    });
  });
});

it('loads Agent settings saved with a removed provider without losing them', () => {
  localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({
      version: 1,
      temperature: 0.4,
      provider: persisted('deepseek'),
      providerConfigs: { deepseek: persisted('deepseek'), xai: persisted('xai') },
    }),
  );
  localStorage.setItem(API_KEYS_LOCAL, JSON.stringify({ deepseek: 'sk-d', xai: 'sk-x' }));

  const settings = new BrowserAppSettingsStore().load();

  expect(settings.temperature).toBe(0.4);
  expect(settings.provider).toMatchObject({
    providerId: 'custom',
    apiKey: 'sk-d',
    model: 'deepseek-model',
    baseUrl: 'https://api.deepseek.com',
    imageInput: false,
  });
  expect(Object.keys(settings.providerConfigs).sort()).toEqual(['custom', 'managed']);
});
