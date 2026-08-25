import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadScenes,
  newSceneId,
  saveScenes,
  subscribeScenes,
  updateScenes,
  withImportedMarketScene,
} from './index';

beforeEach(() => localStorage.clear());

describe('共享场景库', () => {
  it('没有任何记录时是空库', () => {
    expect(loadScenes()).toEqual({ scenes: [], selectedId: 'gentle', hiddenBuiltinIds: [] });
  });

  it('存取往返', () => {
    const lib = {
      scenes: [{ id: 'a', name: '自定义', prompt: '你是…' }],
      selectedId: 'a',
      hiddenBuiltinIds: ['tease'],
    };
    saveScenes(lib);
    expect(loadScenes()).toEqual(lib);
  });

  describe('一条坏场景不能带走整个库', () => {
    it('坏的那条被丢掉，其余保留', () => {
      localStorage.setItem(
        '0xnullai.scenes',
        JSON.stringify({
          scenes: [
            { id: 'good', name: '好的', prompt: 'x' },
            { id: 'no-name', prompt: 'x' },
            null,
            { name: '无 id', prompt: 'x' },
            { id: 'good2', name: '也好', prompt: '' },
          ],
          selectedId: 'good',
          hiddenBuiltinIds: [],
        }),
      );
      // Exactly the property the extraction from Agent's big blob buys:
      // there, one failed zod check reverted the whole blob to defaults,
      // and scenes shared that blob with the strength caps — one corrupt
      // scene silently reset the user's safety settings.
      expect(loadScenes().scenes.map((s) => s.id)).toEqual(['good', 'good2']);
    });

    it('整份是坏 JSON 时回落空库而不是抛出', () => {
      localStorage.setItem('0xnullai.scenes', '{不是 JSON');
      expect(() => loadScenes()).not.toThrow();
      expect(loadScenes().scenes).toEqual([]);
    });
  });

  describe('从两个旧库迁移', () => {
    it('Agent 与 Voice 的自定义场景合并，不是二选一', () => {
      localStorage.setItem(
        'dg-agent.browser-settings',
        JSON.stringify({
          savedPromptPresets: [{ id: 'from-agent', name: 'A', prompt: 'a' }],
          promptPresetId: 'from-agent',
          hiddenBuiltinPresetIds: ['tease'],
          maxStrengthA: 50,
        }),
      );
      localStorage.setItem(
        'dg-voice-settings',
        JSON.stringify({
          savedPromptPresets: [{ id: 'from-voice', name: 'V', prompt: 'v' }],
          hiddenBuiltinPresetIds: ['reward'],
        }),
      );
      const lib = loadScenes();
      // Both sides are the user's own work; picking one deletes half.
      expect(lib.scenes.map((s) => s.id).sort()).toEqual(['from-agent', 'from-voice']);
      expect(lib.hiddenBuiltinIds.sort()).toEqual(['reward', 'tease']);
      expect(lib.selectedId).toBe('from-agent');
    });

    it('同 id 不重复', () => {
      const same = { savedPromptPresets: [{ id: 'dup', name: 'X', prompt: 'x' }] };
      localStorage.setItem('dg-agent.browser-settings', JSON.stringify(same));
      localStorage.setItem('dg-voice-settings', JSON.stringify(same));
      expect(loadScenes().scenes).toHaveLength(1);
    });

    it('一个旧库坏掉不影响另一个', () => {
      localStorage.setItem('dg-agent.browser-settings', '{坏的');
      localStorage.setItem(
        'dg-voice-settings',
        JSON.stringify({ savedPromptPresets: [{ id: 'v', name: 'V', prompt: 'v' }] }),
      );
      expect(loadScenes().scenes.map((s) => s.id)).toEqual(['v']);
    });

    it('迁移只发生一次', () => {
      localStorage.setItem(
        'dg-agent.browser-settings',
        JSON.stringify({ savedPromptPresets: [{ id: 'one', name: 'O', prompt: 'o' }] }),
      );
      expect(loadScenes().scenes).toHaveLength(1);
      localStorage.setItem(
        'dg-agent.browser-settings',
        JSON.stringify({ savedPromptPresets: [{ id: 'two', name: 'T', prompt: 't' }] }),
      );
      // Migration wrote our own key; the legacy keys no longer matter.
      expect(loadScenes().scenes.map((s) => s.id)).toEqual(['one']);
    });
  });

  it('导入市场场景后立即选中，重复导入按确定 id 去重', () => {
    const item = {
      id: 'monster',
      type: 'scenario' as const,
      name: ' Monster ',
      icon: '🐙',
      tags: [],
      content: { prompt: '  roleplay  ' },
      downloads: 0,
      createdAt: 0,
    };
    const first = withImportedMarketScene(loadScenes(), item);
    const second = withImportedMarketScene(first, {
      ...item,
      name: 'Changed upstream',
      content: { prompt: 'replacement' },
    });

    expect(second.selectedId).toBe('market-monster');
    expect(second.scenes).toEqual([
      { id: 'market-monster', name: 'Monster', icon: '🐙', prompt: 'roleplay' },
    ]);
  });

  it('拒绝畸形市场导入且不写存储或改变选择', () => {
    const initial = {
      scenes: [{ id: 'kept', name: 'Kept', prompt: 'safe' }],
      selectedId: 'kept',
      hiddenBuiltinIds: [],
    };
    localStorage.setItem('0xnullai.scenes', JSON.stringify(initial));
    const before = localStorage.getItem('0xnullai.scenes');
    const invalidItems: unknown[] = [
      null,
      { id: 'wave', type: 'waveform', name: 'Wave', content: { prompt: 'x' } },
      { id: '../escape', type: 'scenario', name: 'Bad id', content: { prompt: 'x' } },
      { id: 'blank-name', type: 'scenario', name: '   ', content: { prompt: 'x' } },
      { id: 'null-content', type: 'scenario', name: 'Null', content: null },
      { id: 'array-content', type: 'scenario', name: 'Array', content: [{ prompt: 'x' }] },
      { id: 'blank-prompt', type: 'scenario', name: 'Blank', content: { prompt: '   ' } },
      {
        id: 'long-prompt',
        type: 'scenario',
        name: 'Long',
        content: { prompt: 'x'.repeat(12_001) },
      },
    ];

    for (const item of invalidItems) {
      const result = updateScenes((current) => withImportedMarketScene(current, item));
      expect(result).toEqual(initial);
      expect(localStorage.getItem('0xnullai.scenes')).toBe(before);
    }
  });

  it('订阅能收到同文档内的改动', () => {
    const seen: number[] = [];
    const stop = subscribeScenes((lib) => seen.push(lib.scenes.length));
    updateScenes((prev) => ({ ...prev, scenes: [{ id: 'x', name: 'X', prompt: 'x' }] }));
    stop();
    updateScenes((prev) => ({ ...prev, scenes: [] }));
    expect(seen).toEqual([1]);
  });

  it('新 id 不会撞', () => {
    // Pre-merge this was `custom-${Date.now()}`: merging two libraries
    // collides ids created in the same millisecond, and lookup is find() —
    // a collision is silent shadowing, a scene that "does nothing when
    // clicked".
    const ids = new Set(Array.from({ length: 200 }, () => newSceneId()));
    expect(ids.size).toBe(200);
  });
});
