/**
 * @vitest-environment jsdom
 *
 * The shared config store reads the global localStorage, not the storage
 * injected into BrowserAppSettingsStore, so this file needs a DOM.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveLlmConfig } from '@0xnullai/llm-providers';
import { BrowserAppSettingsStore } from './browser-settings-store.js';

/**
 * The unified settings panel tells the user 「Agent 与 Chat 共用这一份配置」.
 * That was false: Agent read `dg-agent.browser-settings` while the panel wrote
 * `0xnullai.llm-config`, and Agent's own provider UI had already moved into
 * that panel — so Agent read a store nothing wrote, and there was no way to
 * configure it at all.
 *
 * The second case matters as much as the first: `loadLlmConfig()` always
 * returns something, so taking it unconditionally would let an untouched
 * store overwrite Agent's persisted provider with the default.
 */

function store() {
  return new BrowserAppSettingsStore({});
}

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('Agent 读取共享的模型配置', () => {
  it('用户在统一设置里选了供应商，Agent 就跟着走', () => {
    saveLlmConfig({
      providerId: 'openai',
      apiKey: 'sk-shared',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1',
    });

    const loaded = store().load();

    expect(loaded.provider.providerId).toBe('openai');
    expect(loaded.provider.apiKey).toBe('sk-shared');
    expect(loaded.provider.model).toBe('gpt-4o-mini');
  });

  it('共享设置改了，Agent 下一次读取就是新的', () => {
    saveLlmConfig({ providerId: 'openai', apiKey: 'sk-a', model: 'm1', baseUrl: 'https://a' });
    expect(store().load().provider.apiKey).toBe('sk-a');

    saveLlmConfig({ providerId: 'openai', apiKey: 'sk-b', model: 'm2', baseUrl: 'https://a' });
    expect(store().load().provider.apiKey).toBe('sk-b');
    expect(store().load().provider.model).toBe('m2');
  });

  it('用户没碰过统一设置时，不能拿默认值盖掉 Agent 自己存的供应商', () => {
    // No shared config written at all — loadLlmConfig would still hand back
    // its `free` default, which must not win here.
    const s = store();
    const base = s.load();
    s.save({ ...base, provider: { ...base.provider, providerId: 'openai', apiKey: 'sk-own' } });

    const reloaded = store().load();

    expect(reloaded.provider.providerId).toBe('openai');
  });
});
