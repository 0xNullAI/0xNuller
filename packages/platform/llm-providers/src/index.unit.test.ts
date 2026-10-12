import { describe, expect, it } from 'vitest';
import {
  MANAGED_MODEL_OPTIONS,
  PROVIDER_DEFINITIONS,
  createProviderSettings,
  normalizeProviderSettings,
  resolveProviderRuntimeSettings,
  supportsProviderImageInput,
} from './index';
import { defaultVideoLlmConfig, isVideoLlmConfigured } from './video-config-store';

describe('provider catalog', () => {
  it('offers only the managed plan and one custom OpenAI-compatible endpoint', () => {
    expect(PROVIDER_DEFINITIONS.map((provider) => provider.id)).toEqual(['managed', 'custom']);
  });
});

describe('managed Workers AI models', () => {
  it('keeps a supported tier and rejects unknown ids', () => {
    const base = createProviderSettings('managed');
    expect(normalizeProviderSettings({ ...base, model: 'powerful' }).model).toBe('powerful');
    expect(normalizeProviderSettings({ ...base, model: '@cf/private/model' }).model).toBe(
      'balanced',
    );
  });

  it('exposes three text-only tiers to the client and offers the managed image model only to Video', () => {
    expect(MANAGED_MODEL_OPTIONS.map((option) => option.id)).toEqual([
      'basic',
      'balanced',
      'powerful',
    ]);
    expect(
      resolveProviderRuntimeSettings({
        ...createProviderSettings('managed'),
        model: 'basic',
        // A stored toggle never turns a text tier into a vision model.
        imageInput: true,
      }),
    ).toMatchObject({ model: 'basic', imageInput: false });
    expect(
      supportsProviderImageInput({ providerId: 'managed', model: 'balanced', imageInput: true }),
    ).toBe(false);

    const video = defaultVideoLlmConfig();
    expect(video).toMatchObject({ providerId: 'managed', model: 'vision' });
    expect(isVideoLlmConfigured(video)).toBe(true);
    expect(
      resolveProviderRuntimeSettings({ ...createProviderSettings('managed'), model: 'vision' }),
    ).toMatchObject({ imageInput: true });
  });
});

describe('custom image input', () => {
  const custom = () =>
    normalizeProviderSettings({
      ...createProviderSettings('custom'),
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.org/v1/',
      model: ' vl-model ',
    });

  it('is off by default and only on after the user switches it on', () => {
    expect(custom()).toMatchObject({ imageInput: false, model: 'vl-model' });
    expect(resolveProviderRuntimeSettings(custom()).imageInput).toBe(false);
    expect(resolveProviderRuntimeSettings({ ...custom(), imageInput: true }).imageInput).toBe(true);
  });

  it('treats a missing toggle from an older caller as off', () => {
    const { imageInput: _omitted, ...withoutToggle } = custom();
    expect(
      normalizeProviderSettings(withoutToggle as Parameters<typeof normalizeProviderSettings>[0])
        .imageInput,
    ).toBe(false);
  });

  it('keeps Video disabled until the custom model is marked as image-capable', () => {
    const video = { ...defaultVideoLlmConfig(), ...custom() };
    expect(isVideoLlmConfigured(video)).toBe(false);
    expect(isVideoLlmConfigured({ ...video, imageInput: true })).toBe(true);
    expect(isVideoLlmConfigured({ ...video, imageInput: true, apiKey: ' ' })).toBe(false);
  });
});

describe('自定义模型的服务商', () => {
  it('recognises a preset address with or without a trailing slash', async () => {
    const { customProviderPresetFor } = await import('./index');
    expect(customProviderPresetFor('https://api.deepseek.com/v1/')).toBe('deepseek');
    expect(customProviderPresetFor('https://ark.cn-beijing.volces.com/api/v3')).toBe('ark');
    expect(customProviderPresetFor('https://example.org/v1')).toBeNull();
  });
});
