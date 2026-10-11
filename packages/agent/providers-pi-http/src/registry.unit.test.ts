import { describe, expect, it } from 'vitest';
import { loadPiAiProvider, resolvePiAiModel } from './registry.js';

describe('resolvePiAiModel', () => {
  it('gives a Claude model newer than the catalog the current Claude request shape', async () => {
    const anthropic = await loadPiAiProvider('anthropic');
    const model = resolvePiAiModel(anthropic, 'claude-opus-5-5');
    expect(model).toMatchObject({
      id: 'claude-opus-5-5',
      api: 'anthropic-messages',
      reasoning: true,
      compat: { forceAdaptiveThinking: true, supportsTemperature: false },
      thinkingLevelMap: { off: null },
    });
  });

  it('keeps catalog models and the generic fallback for other unknown ids unchanged', async () => {
    const anthropic = await loadPiAiProvider('anthropic');
    expect(resolvePiAiModel(anthropic, 'claude-sonnet-4-5').id).toBe('claude-sonnet-4-5');
    const unknown = resolvePiAiModel(anthropic, 'custom-proxy-model');
    expect(unknown.reasoning).toBe(false);
    expect(unknown.compat).toBeUndefined();
  });
});

describe('resolvePiAiModel catalog hints', () => {
  it('applies models.dev vision and sampling flags to a model the bundled table lacks', async () => {
    const openrouter = await loadPiAiProvider('openrouter');
    const model = resolvePiAiModel(openrouter, 'vendor/brand-new-vision-model', {
      image: true,
      temperature: false,
    });
    expect(model.input).toContain('image');
    expect(model.compat).toMatchObject({ supportsTemperature: false });
    const plain = resolvePiAiModel(openrouter, 'vendor/brand-new-text-model');
    expect(plain.input).toEqual(['text']);
  });
});
