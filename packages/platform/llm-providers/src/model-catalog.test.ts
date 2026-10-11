import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getProviderImageModels,
  loadModelCatalog,
  normalizeProviderSettings,
  createProviderSettings,
  resetModelCatalogForTests,
  supportsProviderModelImageInput,
  type CatalogModel,
} from './index';

const model = (id: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({
  id,
  name: id,
  family: null,
  image: false,
  reasoning: false,
  temperature: true,
  toolCall: true,
  context: null,
  output: null,
  releaseDate: null,
  ...extra,
});

afterEach(() => {
  resetModelCatalogForTests();
  vi.unstubAllGlobals();
});

describe('models.dev catalog', () => {
  it('takes vision support from the catalog and fails closed for unknown or unloaded models', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
    expect(supportsProviderModelImageInput('anthropic', 'claude-opus-5-5')).toBe(false);
    resetModelCatalogForTests({
      anthropic: [model('claude-opus-5-5', { image: true }), model('claude-text-only')],
    });
    expect(supportsProviderModelImageInput('anthropic', 'Claude-Opus-5-5')).toBe(true);
    expect(supportsProviderModelImageInput('anthropic', 'claude-text-only')).toBe(false);
    expect(supportsProviderModelImageInput('anthropic', 'claude-not-listed')).toBe(false);
    expect(getProviderImageModels('anthropic')).toEqual(['claude-opus-5-5']);
  });

  it("never picks a model on the user's behalf", () => {
    resetModelCatalogForTests({ anthropic: [model('any', { releaseDate: '2026-09-01' })] });
    const empty = { ...createProviderSettings('anthropic'), model: '' };
    expect(normalizeProviderSettings(empty).model).toBe('');
    expect(normalizeProviderSettings({ ...empty, model: ' chosen ' }).model).toBe('chosen');
  });

  it('shares one request and waits before retrying a failed load', async () => {
    const request = vi.fn(async () => new Response('down', { status: 503 }));
    await Promise.all([loadModelCatalog(request), loadModelCatalog(request)]);
    expect(request).toHaveBeenCalledOnce();
    expect(await loadModelCatalog(request)).toBe(false);
    expect(request).toHaveBeenCalledOnce();
    expect(String(request.mock.calls[0]![0])).toContain('/api/auth/model-catalog?providers=');
  });
});
