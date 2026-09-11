import { describe, expect, it } from 'vitest';
import {
  MANAGED_MODEL_OPTIONS,
  createProviderSettings,
  getProviderRegion,
  normalizeProviderSettings,
  resolveProviderRuntimeSettings,
  supportsProviderModelImageInput,
} from './index';

describe('getProviderRegion', () => {
  it('keeps mainland, international, and custom providers in separate groups', () => {
    expect(getProviderRegion('qwen')).toBe('mainland');
    expect(getProviderRegion('moonshotai-cn')).toBe('mainland');
    expect(getProviderRegion('openai')).toBe('international');
    expect(getProviderRegion('custom')).toBe('custom');
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

  it('exposes three text-only tiers to the client', () => {
    expect(MANAGED_MODEL_OPTIONS.map((option) => option.id)).toEqual([
      'basic',
      'balanced',
      'powerful',
    ]);
    expect(
      resolveProviderRuntimeSettings({
        ...createProviderSettings('managed'),
        model: 'basic',
      }),
    ).toMatchObject({ model: 'basic', imageInput: false });
    expect(supportsProviderModelImageInput('managed', 'balanced')).toBe(false);
  });
});
