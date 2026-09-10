import { describe, expect, it } from 'vitest';
import { getProviderRegion } from './index';

describe('getProviderRegion', () => {
  it('keeps mainland, international, and custom providers in separate groups', () => {
    expect(getProviderRegion('qwen')).toBe('mainland');
    expect(getProviderRegion('moonshotai-cn')).toBe('mainland');
    expect(getProviderRegion('openai')).toBe('international');
    expect(getProviderRegion('custom')).toBe('custom');
  });
});
