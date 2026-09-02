import { describe, expect, it } from 'vitest';
import { withImportedMarketScene, type SceneLibrary } from './index.js';

const emptyLibrary = (): SceneLibrary => ({
  scenes: [],
  selectedId: 'gentle',
  hiddenBuiltinIds: [],
});

describe('Market scene import', () => {
  it('imports an extra-large prompt up to the Market transport ceiling', () => {
    const prompt = '界'.repeat(100_000);
    const result = withImportedMarketScene(emptyLibrary(), {
      id: 'large-world-book',
      type: 'scenario',
      name: '超大世界书',
      content: { prompt, scale: 'extra-large' },
    });

    expect(result.selectedId).toBe('market-large-world-book');
    expect(result.scenes[0]?.prompt).toBe(prompt);
  });

  it('rejects prompts above the Market transport ceiling', () => {
    const current = emptyLibrary();
    expect(
      withImportedMarketScene(current, {
        id: 'too-large',
        type: 'scenario',
        name: '过大场景',
        content: { prompt: '界'.repeat(100_001), scale: 'extra-large' },
      }),
    ).toBe(current);
  });
});
