import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  loadLlmConfig,
  saveLlmConfig,
  defaultLlmConfig,
  isLlmConfigured,
  subscribeLlmConfig,
} from './config-store';

beforeEach(() => localStorage.clear());

describe('共享 LLM 配置', () => {
  it('没有存储时给出免费 provider 的默认值——「无需配置就能用」是产品承诺', () => {
    const c = defaultLlmConfig();
    expect(c.providerId).toBe('free');
    expect(isLlmConfigured(c)).toBe(true);
  });

  it('round-trip 保存与读取', () => {
    const c = {
      providerId: 'deepseek',
      apiKey: 'sk-x',
      model: 'deepseek-chat',
      baseUrl: 'https://x',
    };
    saveLlmConfig(c);
    expect(loadLlmConfig()).toEqual(c);
  });

  it('从各模块合并前的旧键一次性迁移', () => {
    // A provider configured in DG-Chat must carry over after the merge —
    // no reconfiguration.
    localStorage.setItem(
      'dg-chat-ai-config',
      JSON.stringify({
        providerId: 'qwen',
        apiKey: 'sk-old',
        model: 'qwen3.5-plus',
        baseUrl: 'https://q',
      }),
    );
    expect(loadLlmConfig().providerId).toBe('qwen');
    // Migration writes the new key; legacy keys are never read again
    localStorage.removeItem('dg-chat-ai-config');
    expect(loadLlmConfig().apiKey).toBe('sk-old');
  });

  it('存储被污染时回落默认值，而不是让模块崩在启动阶段', () => {
    localStorage.setItem('0xnullai.llm-config', '{ 这不是 JSON');
    expect(loadLlmConfig().providerId).toBe('free');
  });

  it('非免费 provider 缺 key 时视为未配置', () => {
    expect(
      isLlmConfigured({ providerId: 'deepseek', apiKey: '  ', model: 'm', baseUrl: 'b' }),
    ).toBe(false);
    expect(
      isLlmConfigured({ providerId: 'deepseek', apiKey: 'sk', model: 'm', baseUrl: 'b' }),
    ).toBe(true);
  });

  it('订阅者在保存时收到通知——这是「一处改、各模块同步」的机制', () => {
    const seen = vi.fn();
    const off = subscribeLlmConfig(seen);
    saveLlmConfig({ providerId: 'free', apiKey: '', model: 'm', baseUrl: 'b' });
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'free' }));
    off();
  });
});
