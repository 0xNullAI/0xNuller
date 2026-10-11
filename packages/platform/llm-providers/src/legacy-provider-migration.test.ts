import { afterEach, describe, expect, it } from 'vitest';
import {
  coerceLlmConfig,
  isLlmConfigured,
  loadLlmConfig,
  migrateLegacyProviderId,
  migrateLegacyProviderSettings,
  normalizeProviderSettings,
  type ProviderSettings,
} from './index';
import { coerceVideoLlmConfig, isVideoLlmConfigured } from './video-config-store';

const stored = (providerId: string, extra: Record<string, unknown> = {}) => ({
  providerId,
  apiKey: 'sk-saved',
  model: 'saved-model',
  baseUrl: '',
  endpoint: 'chat/completions' as const,
  useStrict: false,
  ...extra,
});

afterEach(() => localStorage.clear());

describe('migrateLegacyProviderSettings', () => {
  it.each([
    ['qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
    ['deepseek', 'https://api.deepseek.com'],
    ['doubao', 'https://ark.cn-beijing.volces.com/api/v3'],
    ['openrouter', 'https://openrouter.ai/api/v1'],
    ['groq', 'https://api.groq.com/openai/v1'],
    ['moonshotai', 'https://api.moonshot.ai/v1'],
    ['moonshotai-cn', 'https://api.moonshot.cn/v1'],
    ['zai', 'https://api.z.ai/api/coding/paas/v4'],
    ['zai-coding-cn', 'https://open.bigmodel.cn/api/coding/paas/v4'],
    ['xai', 'https://api.x.ai/v1'],
    ['cerebras', 'https://api.cerebras.ai/v1'],
    ['together', 'https://api.together.ai/v1'],
    ['huggingface', 'https://router.huggingface.co/v1'],
    ['fireworks', 'https://api.fireworks.ai/inference/v1'],
    ['xiaomi', 'https://api.xiaomimimo.com/v1'],
    ['mistral', 'https://api.mistral.ai/v1'],
    ['google', 'https://generativelanguage.googleapis.com/v1beta/openai'],
  ])('moves %s to custom with its key, model and OpenAI-compatible host', (id, baseUrl) => {
    expect(migrateLegacyProviderId(id)).toBe('custom');
    expect(migrateLegacyProviderSettings(stored(id))).toEqual({
      providerId: 'custom',
      apiKey: 'sk-saved',
      model: 'saved-model',
      baseUrl,
      endpoint: 'chat/completions',
      useStrict: false,
      imageInput: false,
    });
  });

  it('keeps an edited OpenAI URL and the Responses endpoint it used', () => {
    expect(
      migrateLegacyProviderSettings(stored('openai', { baseUrl: 'https://proxy.example/v1' })),
    ).toMatchObject({
      providerId: 'custom',
      baseUrl: 'https://proxy.example/v1',
      endpoint: 'responses',
    });
    expect(migrateLegacyProviderSettings(stored('openai')).baseUrl).toBe(
      'https://api.openai.com/v1',
    );
  });

  it.each(['anthropic', 'minimax', 'minimax-cn', 'something-new'])(
    'returns %s to managed and drops the foreign key',
    (id) => {
      expect(migrateLegacyProviderId(id)).toBe('managed');
      expect(migrateLegacyProviderSettings(stored(id))).toMatchObject({
        providerId: 'managed',
        apiKey: '',
        imageInput: false,
      });
    },
  );

  it('never turns image input on for a migrated config', () => {
    expect(migrateLegacyProviderSettings(stored('qwen', { imageInput: true })).imageInput).toBe(
      false,
    );
  });

  it('leaves managed and custom configs alone', () => {
    const custom = stored('custom', { baseUrl: 'https://mine.example/v1', imageInput: true });
    expect(migrateLegacyProviderSettings(custom)).toEqual(custom);
  });
});

describe('stored configs naming a removed provider', () => {
  it('normalizes instead of throwing when a legacy id reaches normalizeProviderSettings', () => {
    const settings = normalizeProviderSettings(stored('deepseek') as unknown as ProviderSettings);
    expect(settings).toMatchObject({
      providerId: 'custom',
      apiKey: 'sk-saved',
      model: 'saved-model',
      baseUrl: 'https://api.deepseek.com',
    });
    expect(normalizeProviderSettings(stored('anthropic') as unknown as ProviderSettings)).toEqual(
      expect.objectContaining({ providerId: 'managed', model: 'balanced', apiKey: '' }),
    );
  });

  it('loads a saved Agent/Chat config as a working custom config', () => {
    localStorage.setItem(
      '0xnullai.llm-config',
      JSON.stringify({ ...stored('moonshotai-cn'), rememberApiKey: true }),
    );
    const config = loadLlmConfig();
    expect(config).toMatchObject({
      providerId: 'custom',
      apiKey: 'sk-saved',
      model: 'saved-model',
      baseUrl: 'https://api.moonshot.cn/v1',
      imageInput: false,
    });
    expect(isLlmConfigured(config)).toBe(true);
  });

  it('keeps the legacy free id and remember preference', () => {
    expect(coerceLlmConfig({ ...stored('free'), rememberApiKey: false })).toMatchObject({
      providerId: 'managed',
      rememberApiKey: false,
    });
  });

  it('migrates a Video config but keeps Video off until image input is confirmed', () => {
    const video = coerceVideoLlmConfig({
      version: 1,
      ...stored('qwen', { model: 'qwen3-vl-plus' }),
      rememberApiKey: true,
    });
    expect(video).toMatchObject({
      providerId: 'custom',
      apiKey: 'sk-saved',
      model: 'qwen3-vl-plus',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      imageInput: false,
      rememberApiKey: true,
    });
    expect(isVideoLlmConfigured(video!)).toBe(false);
    expect(isVideoLlmConfigured({ ...video!, imageInput: true })).toBe(true);
  });

  it('sends an unmappable Video config back to managed vision', () => {
    expect(
      coerceVideoLlmConfig({ version: 1, ...stored('anthropic'), rememberApiKey: false }),
    ).toMatchObject({ providerId: 'managed', model: 'vision', apiKey: '' });
  });
});
