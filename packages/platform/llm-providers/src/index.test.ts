import { describe, expect, it } from 'vitest';
import {
  MANAGED_MODEL_OPTIONS,
  createProviderSettings,
  normalizeProviderSettings,
  resolveProviderRuntimeSettings,
  supportsProviderModelImageInput,
} from './index';
import { defaultVideoLlmConfig, isVideoLlmConfigured } from './video-config-store';

describe('managed Workers AI models', () => {
  it('keeps a supported tier and rejects unknown ids', () => {
    const base = createProviderSettings('managed');
    expect(normalizeProviderSettings({ ...base, model: 'powerful' }).model).toBe('powerful');
    expect(normalizeProviderSettings({ ...base, model: '@cf/private/model' }).model).toBe(
      'balanced',
    );
  });

  it('exposes three text-only tiers to the client and offers the managed image model only to Video, while preserving BYOK image providers', () => {
    expect(MANAGED_MODEL_OPTIONS.map((option) => option.id)).toEqual([
      'basic',
      'balanced',
      'powerful',
    ]);
    expect(MANAGED_MODEL_OPTIONS.some((model) => model.id === 'vision')).toBe(false);
    expect(
      resolveProviderRuntimeSettings({
        ...createProviderSettings('managed'),
        model: 'basic',
      }),
    ).toMatchObject({ model: 'basic', imageInput: false });
    expect(resolveProviderRuntimeSettings(createProviderSettings('managed'))).toMatchObject({
      imageInput: false,
    });
    expect(supportsProviderModelImageInput('managed', 'balanced')).toBe(false);

    const video = defaultVideoLlmConfig();
    expect(video).toMatchObject({ providerId: 'managed', model: 'vision' });
    expect(isVideoLlmConfigured(video)).toBe(true);
    expect(
      resolveProviderRuntimeSettings({ ...createProviderSettings('managed'), model: 'vision' }),
    ).toMatchObject({
      imageInput: true,
    });
  });
});
