import { beforeEach, describe, expect, it } from 'vitest';
import { loadScenes, newSceneId, saveScenes, subscribeScenes, updateScenes } from './index';

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
      // 这正是从 Agent 那个大 blob 里拆出来要换取的性质：那边是一处 zod 校验失败
      // 就整份回落默认值，而场景和强度上限住在同一个 blob——一条写坏的场景会
      // 静默重置用户的安全设置。
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
      // 用户在哪边写的都是自己的东西，二选一等于删掉一半。
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
      // 迁移时已写入自己的键，旧键从此无关。
      expect(loadScenes().scenes.map((s) => s.id)).toEqual(['one']);
    });
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
    // 合并前是 `custom-${Date.now()}`：两个库合并时同一毫秒建的会撞 id，
    // 而查找是 find()——撞了就是静默遮蔽，用户会发现某个场景「点了没反应」。
    const ids = new Set(Array.from({ length: 200 }, () => newSceneId()));
    expect(ids.size).toBe(200);
  });
});
