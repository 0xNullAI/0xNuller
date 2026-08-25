import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultLlmConfig, loadLlmConfig, saveLlmConfig } from './config-store';
import { PROVIDER_DEFINITIONS } from './index';
import {
  defaultVideoLlmConfig,
  filterVideoModelIds,
  isVideoLlmConfigured,
  loadVideoLlmConfig,
  saveVideoLlmConfig,
  subscribeVideoLlmConfig,
} from './video-config-store';

describe('Video LLM 配置', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('与 Agent 的 provider、模型和凭据完全隔离', () => {
    saveLlmConfig({
      ...defaultLlmConfig(),
      providerId: 'anthropic',
      model: 'claude-sonnet-4-5',
      apiKey: 'agent-key',
    });
    saveVideoLlmConfig({
      ...defaultVideoLlmConfig(),
      providerId: 'openai',
      model: 'gpt-4o-mini',
      apiKey: 'video-key',
    });

    expect(loadLlmConfig()).toMatchObject({ providerId: 'anthropic', apiKey: 'agent-key' });
    expect(loadVideoLlmConfig()).toMatchObject({ providerId: 'openai', apiKey: 'video-key' });

    saveLlmConfig({ ...loadLlmConfig(), model: 'claude-opus-4-5' });
    expect(loadVideoLlmConfig().model).toBe('gpt-4o-mini');
  });

  it('不从已有 Agent 配置自动复制', () => {
    saveLlmConfig({
      ...defaultLlmConfig(),
      providerId: 'google',
      model: 'gemini-2.5-flash',
      apiKey: 'agent-only',
    });

    expect(loadVideoLlmConfig()).toEqual(defaultVideoLlmConfig());
    expect(loadVideoLlmConfig().apiKey).toBe('');
  });

  it('只接受当前版本，旧版或未知版本失败后回落独立默认值', () => {
    localStorage.setItem(
      '0xnullai.video-llm-config.v1',
      JSON.stringify({ version: 99, providerId: 'google', apiKey: 'leaked' }),
    );
    expect(loadVideoLlmConfig()).toEqual(defaultVideoLlmConfig());
  });

  it('Video provider 只包含浏览器支持且能力为 known-models 的条目', () => {
    const videoProviders = PROVIDER_DEFINITIONS.filter(
      (provider) => provider.browserSupported && provider.imageInput === 'known-models',
    );
    expect(videoProviders.length).toBeGreaterThan(0);
    expect(videoProviders.every((provider) => provider.browserSupported)).toBe(true);
    expect(videoProviders.every((provider) => provider.imageInput === 'known-models')).toBe(true);
    expect(videoProviders.map((provider) => provider.id)).not.toEqual(
      expect.arrayContaining(['free', 'custom', 'deepseek']),
    );
  });

  it('过滤静态和动态发现结果中的文本、未知及自定义模型', () => {
    expect(
      filterVideoModelIds('openai', [
        'gpt-4o-mini',
        'gpt-4o-private-preview',
        'gpt-3.5-turbo',
        'unknown-model',
      ]),
    ).toEqual(['gpt-4o-mini']);
    expect(filterVideoModelIds('custom', ['gpt-4o-mini'])).toEqual([]);
    expect(filterVideoModelIds('free', ['openrouter/free'])).toEqual([]);
  });

  it('持久化的未知或纯文本模型明确视为不可用', () => {
    expect(
      isVideoLlmConfigured({
        ...defaultVideoLlmConfig(),
        apiKey: 'sk-video',
        model: 'gpt-4o-private-preview',
      }),
    ).toBe(false);
    expect(
      isVideoLlmConfigured({
        ...defaultVideoLlmConfig(),
        providerId: 'deepseek',
        apiKey: 'sk-video',
        model: 'deepseek-v4-pro',
      }),
    ).toBe(false);
    expect(
      isVideoLlmConfigured({
        ...defaultVideoLlmConfig(),
        apiKey: 'sk-video',
        model: 'gpt-4o-mini',
      }),
    ).toBe(true);
  });

  it('Video 订阅只接收 Video 保存，取消后停止通知', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeVideoLlmConfig(listener);
    saveLlmConfig({ ...defaultLlmConfig(), model: 'agent-change' });
    expect(listener).not.toHaveBeenCalled();

    saveVideoLlmConfig({ ...defaultVideoLlmConfig(), model: 'gpt-4o' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'gpt-4o' }));

    unsubscribe();
    saveVideoLlmConfig({ ...defaultVideoLlmConfig(), model: 'gpt-4.1' });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
