import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetSceneSyncForTests,
  loadScenes,
  legacyScenesToImportCount,
  importLegacyScenes,
  importMarketSceneOnline,
  saveScenes,
  syncScenes,
  savedPromptKind,
  withImportedMarketScene,
  withUpdatedMarketScene,
  type SceneLibrary,
} from './index.js';

const auth = vi.hoisted(() => ({ account: 'alice' as string | null }));
vi.mock('@0xnullai/auth', () => ({ currentAuthUserId: () => auth.account }));

const syncMocks = vi.hoisted(() => ({
  pullContent: vi.fn(),
  pullContentPreferences: vi.fn(),
  pushContent: vi.fn(),
  pushContentPreferences: vi.fn(),
}));
vi.mock('@0xnullai/sync', () => syncMocks);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  auth.account = 'alice';
  localStorage.clear();
  __resetSceneSyncForTests();
  for (const mock of Object.values(syncMocks)) mock.mockReset();
  syncMocks.pullContent.mockResolvedValue(null);
  syncMocks.pullContentPreferences.mockResolvedValue(null);
  syncMocks.pushContent.mockResolvedValue(undefined);
  syncMocks.pushContentPreferences.mockResolvedValue(undefined);
});

const emptyLibrary = (): SceneLibrary => ({
  scenes: [],
  selectedId: 'gentle',
  hiddenBuiltinIds: [],
});

describe('Market scene import', () => {
  it('keeps an empty selection when the first imported card is only an environment', async () => {
    syncMocks.pullContent.mockResolvedValue([]);
    syncMocks.pushContent.mockResolvedValue(true);
    const result = await importMarketSceneOnline(
      {
        id: 'rain',
        type: 'scenario',
        name: '雨夜',
        content: { kind: 'scene', prompt: '窗外下雨' },
      },
      { select: false },
    );
    expect(result.scenes.map((card) => card.id)).toEqual(['market-rain']);
    expect(result.selectedId).toBe('');
    expect(loadScenes().selectedId).toBe('');
    expect(syncMocks.pushContentPreferences).not.toHaveBeenCalled();
  });

  it('re-imports a card deleted on another device only on an explicit request', async () => {
    const rain = {
      id: 'rain',
      type: 'scenario',
      name: '雨夜',
      content: { kind: 'scene', prompt: '窗外下雨' },
    };
    syncMocks.pullContent.mockResolvedValue([
      { id: 'market-rain', name: '雨夜', payload: { prompt: '窗外下雨' }, deleted: true },
    ]);
    syncMocks.pushContent.mockResolvedValue(true);
    const pushedRain = () =>
      syncMocks.pushContent.mock.calls.filter(([items]) =>
        (items as Array<{ id: string; deleted?: boolean }>).some(
          (item) => item.id === 'market-rain' && !item.deleted,
        ),
      ).length;
    await expect(importMarketSceneOnline(rain, { select: false })).rejects.toThrow(
      '已在其他设备删除',
    );
    expect(pushedRain()).toBe(0);
    const result = await importMarketSceneOnline(rain, { select: false, restoreDeleted: true });
    expect(result.scenes.map((card) => card.id)).toEqual(['market-rain']);
    expect(pushedRain()).toBe(1);
  });

  it('does not select an unrelated saved character when importing an environment', async () => {
    saveScenes(
      {
        selectedId: '',
        hiddenBuiltinIds: [],
        scenes: [{ id: 'friend', name: '朋友', prompt: '你是朋友', kind: 'character' }],
      },
      true,
    );
    syncMocks.pullContent.mockResolvedValue([]);
    syncMocks.pushContent.mockResolvedValue(true);
    const result = await importMarketSceneOnline(
      { id: 'rain', type: 'scenario', name: '雨夜', content: { kind: 'scene', prompt: '下雨' } },
      { select: false },
    );
    expect(result.selectedId).toBe('');
    expect(loadScenes().selectedId).toBe('');
    expect(syncMocks.pushContentPreferences).not.toHaveBeenCalled();
  });

  it('imports an environment without replacing the selected role', async () => {
    saveScenes(
      {
        selectedId: 'my-character',
        hiddenBuiltinIds: [],
        scenes: [{ id: 'my-character', name: '朋友', prompt: '你是朋友', kind: 'character' }],
      },
      true,
    );
    syncMocks.pullContent.mockResolvedValue([]);
    syncMocks.pushContent.mockResolvedValue(true);
    const result = await importMarketSceneOnline(
      {
        id: 'rain',
        type: 'scenario',
        name: '雨夜',
        content: { kind: 'scene', prompt: '窗外下雨' },
      },
      { select: false },
    );
    expect(result.selectedId).toBe('my-character');
    expect(result.scenes.map((card) => card.id)).toContain('market-rain');
    expect(syncMocks.pushContentPreferences).not.toHaveBeenCalled();
  });

  it('does not finish a scene import after an A → B → A account round trip', async () => {
    syncMocks.pullContent.mockResolvedValue([]);
    const upload = deferred<boolean>();
    syncMocks.pushContent.mockImplementation((items: { id: string }[]) =>
      items.some((entry) => entry.id === 'market-rain') ? upload.promise : Promise.resolve(true),
    );
    const pending = importMarketSceneOnline(
      { id: 'rain', type: 'scenario', name: '雨夜', content: { kind: 'scene', prompt: '雨夜' } },
      { select: false },
    );
    await vi.waitFor(() =>
      expect(syncMocks.pushContent).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'market-rain' }),
      ]),
    );
    auth.account = 'bob';
    window.dispatchEvent(new Event('0xnullai:auth-changed'));
    auth.account = 'alice';
    window.dispatchEvent(new Event('0xnullai:auth-changed'));
    upload.resolve(true);
    await expect(pending).rejects.toThrow('账号已切换');
    expect(loadScenes().scenes).toEqual([]);
  });

  it('confirms the server snapshot and selection before opening an imported character', async () => {
    syncMocks.pullContent.mockResolvedValue([]);
    syncMocks.pushContent.mockResolvedValue(true);
    syncMocks.pushContentPreferences.mockResolvedValue(true);
    const item = {
      id: 'role',
      type: 'scenario',
      name: '小岚',
      content: {
        kind: 'character',
        prompt: '你是小岚',
        characterCard: {
          schemaVersion: 1,
          description: '',
          personality: '',
          greeting: '',
          exampleDialogue: '',
          tags: [],
          creator: '',
          license: '',
        },
      },
    };
    const result = await importMarketSceneOnline(item);
    expect(result.selectedId).toBe('market-role');
    expect(result.scenes[0]?.kind).toBe('character');
    expect(syncMocks.pushContent).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'market-role',
        payload: expect.objectContaining({ kind: 'character' }),
      }),
    ]);
    expect(syncMocks.pushContentPreferences).toHaveBeenCalledWith('scene', {
      selectedId: 'market-role',
      hiddenBuiltinIds: [],
    });
    expect(loadScenes().selectedId).toBe('market-role');
  });

  it('leaves the local import unapplied when the online write fails, then retries with the same id', async () => {
    syncMocks.pullContent.mockResolvedValue([]);
    let failed = false;
    syncMocks.pushContent.mockImplementation(async (items: { id: string }[]) => {
      if (items.some((entry) => entry.id === 'market-role') && !failed) {
        failed = true;
        return false;
      }
      return true;
    });
    syncMocks.pushContentPreferences.mockResolvedValue(true);
    const item = { id: 'role', type: 'scenario', name: '角色', content: { prompt: '设定' } };
    await expect(importMarketSceneOnline(item)).rejects.toThrow('尚未保存到云端');
    expect(loadScenes().scenes).toEqual([]);
    const result = await importMarketSceneOnline(item);
    expect(result.scenes.map((scene) => scene.id)).toEqual(['market-role']);
  });

  it('does not overwrite a server-owned private edit on repeat import', async () => {
    syncMocks.pullContent.mockResolvedValue([
      {
        id: 'market-role',
        kind: 'scene',
        name: '我的名字',
        payload: { prompt: '私人修改', kind: 'scene' },
        deleted: false,
      },
    ]);
    syncMocks.pushContentPreferences.mockResolvedValue(true);
    const item = { id: 'role', type: 'scenario', name: '公开名', content: { prompt: '公开设定' } };
    const result = await importMarketSceneOnline(item);
    expect(result.scenes[0]?.name).toBe('我的名字');
    expect(result.scenes[0]?.prompt).toBe('私人修改');
    expect(syncMocks.pushContent).not.toHaveBeenCalledWith([
      expect.objectContaining({ id: 'market-role' }),
    ]);
  });

  it('restores a previously saved server snapshot when this browser has no local copy', async () => {
    syncMocks.pullContent.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: 'market-valley',
        kind: 'scene',
        name: '我的山谷',
        payload: { prompt: '私人规则', kind: 'scene' },
        deleted: false,
      },
    ]);
    syncMocks.pushContentPreferences.mockResolvedValue(true);
    const result = await importMarketSceneOnline({
      id: 'valley',
      type: 'scenario',
      name: '公开山谷',
      content: { prompt: '公开规则' },
    });
    expect(result.scenes[0]).toMatchObject({
      id: 'market-valley',
      name: '我的山谷',
      prompt: '私人规则',
    });
    expect(syncMocks.pushContent).not.toHaveBeenCalledWith([
      expect.objectContaining({ id: 'market-valley' }),
    ]);
  });

  it('rejects a stale import after the account switches during the server write', async () => {
    syncMocks.pullContent.mockResolvedValue([]);
    const pending = deferred<boolean>();
    syncMocks.pushContent.mockReturnValue(pending.promise);
    const task = importMarketSceneOnline({
      id: 'valley',
      type: 'scenario',
      name: '山谷',
      content: { prompt: '环境规则' },
    });
    await vi.waitFor(() => expect(syncMocks.pushContent).toHaveBeenCalled());
    auth.account = 'bob';
    window.dispatchEvent(new Event('0xnullai:auth-changed'));
    pending.resolve(true);
    await expect(task).rejects.toThrow('账号已切换');
    expect(loadScenes().scenes).toEqual([]);
    expect(syncMocks.pushContentPreferences).not.toHaveBeenCalled();
  });

  it('can retry selection sync without uploading the card again', async () => {
    syncMocks.pullContent.mockResolvedValue([]);
    syncMocks.pushContent.mockResolvedValue(true);
    syncMocks.pushContentPreferences.mockResolvedValueOnce(false).mockResolvedValue(true);
    const item = { id: 'role', type: 'scenario', name: '角色', content: { prompt: '设定' } };
    await expect(importMarketSceneOnline(item)).rejects.toThrow('选择尚未同步');
    expect(loadScenes().scenes).toEqual([]);
    syncMocks.pullContent.mockResolvedValue([
      {
        id: 'market-role',
        kind: 'scene',
        name: '角色',
        payload: { prompt: '设定', kind: 'scene' },
        deleted: false,
      },
    ]);
    const result = await importMarketSceneOnline(item);
    expect(result.selectedId).toBe('market-role');
    expect(result.scenes).toHaveLength(1);
  });

  it('refuses to turn an existing private scene into a character relationship', async () => {
    syncMocks.pullContent.mockResolvedValue([
      {
        id: 'market-role',
        kind: 'scene',
        name: '旧场景',
        payload: { prompt: '旧环境', kind: 'scene' },
        deleted: false,
      },
    ]);
    const item = {
      id: 'role',
      type: 'scenario',
      name: '公开角色',
      content: {
        kind: 'character',
        prompt: '人物设定',
        characterCard: {
          schemaVersion: 1,
          description: '',
          personality: '',
          greeting: '',
          exampleDialogue: '',
          tags: [],
          creator: '',
          license: '',
        },
      },
    };
    await expect(importMarketSceneOnline(item)).rejects.toThrow('类型与公开卡不一致');
    expect(syncMocks.pushContentPreferences).not.toHaveBeenCalled();
  });

  it('only replaces a public snapshot after an explicit newer-version update', () => {
    const original = withImportedMarketScene(emptyLibrary(), {
      id: 'companion',
      revision: 2,
      type: 'scenario',
      name: '小岚',
      content: { prompt: '原设定', characterCard: { schemaVersion: 99 } },
    });
    expect(original.scenes[0]).toEqual({
      id: 'market-companion',
      name: '小岚',
      icon: '📝',
      prompt: '原设定',
      kind: 'scene',
      marketRevision: 2,
    });
    const latest = {
      id: 'companion',
      revision: 3,
      type: 'scenario',
      name: '小岚的新版本',
      content: { prompt: '更新的人设', memory: '不得进入私人关系' },
    };
    expect(withImportedMarketScene(original, latest)).toBe(original);
    const updated = withUpdatedMarketScene(original, latest);
    expect(updated.selectedId).toBe(original.selectedId);
    expect(updated.scenes[0]).toEqual({
      id: 'market-companion',
      name: '小岚的新版本',
      icon: '📝',
      prompt: '更新的人设',
      kind: 'scene',
      marketRevision: 3,
    });
    expect(withUpdatedMarketScene(updated, { ...latest, revision: 2 })).toBe(updated);
    expect(withUpdatedMarketScene(updated, { ...latest, id: 'other' })).toBe(updated);
  });

  it('can explicitly update a legacy import with no recorded revision', () => {
    const legacy: SceneLibrary = {
      ...emptyLibrary(),
      scenes: [{ id: 'market-old', name: '旧导入', prompt: '旧正文' }],
    };
    const updated = withUpdatedMarketScene(legacy, {
      id: 'old',
      revision: 5,
      type: 'scenario',
      name: '新版',
      content: { prompt: '新版正文' },
    });
    expect(updated.scenes[0]?.marketRevision).toBe(5);
    expect(updated.scenes[0]?.prompt).toBe('新版正文');
  });

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

  it('separates character entities from scene rules and refuses a kind-changing update', () => {
    const card = {
      schemaVersion: 1 as const,
      description: '',
      personality: '',
      greeting: '',
      exampleDialogue: '',
      tags: [],
      creator: '',
      license: '',
    };
    const character = withImportedMarketScene(emptyLibrary(), {
      id: 'role',
      type: 'scenario',
      name: '角色',
      revision: 1,
      content: { kind: 'character', prompt: '你是角色', characterCard: card },
    });
    expect(character.scenes[0]?.kind).toBe('character');
    expect(savedPromptKind(character.scenes[0]!)).toBe('character');
    expect(
      withUpdatedMarketScene(character, {
        id: 'role',
        type: 'scenario',
        name: '场景',
        revision: 2,
        content: { kind: 'scene', prompt: '在山谷中' },
      }),
    ).toBe(character);
    const scene = withImportedMarketScene(emptyLibrary(), {
      id: 'world',
      type: 'scenario',
      name: '山谷',
      content: { kind: 'scene', prompt: '在山谷中' },
    });
    expect(scene.scenes[0]?.kind).toBe('scene');
    expect(scene.scenes[0]?.characterCard).toBeUndefined();
    expect(savedPromptKind(scene.scenes[0]!)).toBe('scene');
    expect(
      withImportedMarketScene(emptyLibrary(), {
        id: 'invalid',
        type: 'scenario',
        name: '非法',
        content: { kind: 'character', prompt: '缺少角色卡' },
      }).scenes,
    ).toEqual([]);
  });
});

describe('场景账户同步', () => {
  it('requires explicit ownership before an old shared cache can enter an account', () => {
    syncMocks.pullContent.mockResolvedValue([]);
    localStorage.setItem(
      '0xnullai.scenes',
      JSON.stringify({
        scenes: [{ id: 'saved-world', name: '旧世界', prompt: '原有设定' }],
        selectedId: 'gentle',
        hiddenBuiltinIds: ['dominant'],
      }),
    );
    expect(loadScenes().scenes).toEqual([]);
    expect(legacyScenesToImportCount()).toBe(1);
    expect(syncMocks.pushContent).not.toHaveBeenCalled();
    expect(importLegacyScenes()).toBe(0);
  });

  it('imports old ownerless cards only after a successful account pull', async () => {
    syncMocks.pullContent.mockResolvedValue([]);
    localStorage.setItem(
      '0xnullai.scenes',
      JSON.stringify({
        scenes: [{ id: 'saved-world', name: '旧世界', prompt: '原有设定' }],
        selectedId: 'gentle',
        hiddenBuiltinIds: ['dominant'],
      }),
    );
    await syncScenes();
    expect(importLegacyScenes()).toBe(1);
    const migrated = loadScenes();
    expect(migrated.selectedId).toBe('saved-world');
    expect(migrated.scenes[0]?.prompt).toBe('原有设定');
    expect(migrated.hiddenBuiltinIds).toEqual(['dominant']);
    expect(JSON.parse(localStorage.getItem('0xnullai.scenes:alice') ?? '{}').selectedId).toBe(
      'saved-world',
    );
    expect(legacyScenesToImportCount()).toBe(0);
    syncMocks.pushContent.mockClear();
    auth.account = 'bob';
    window.dispatchEvent(new Event('0xnullai:auth-changed'));
    expect(loadScenes().scenes).toEqual([]);
    expect(syncMocks.pushContent).not.toHaveBeenCalledWith([
      expect.objectContaining({ id: 'saved-world' }),
    ]);
    localStorage.clear();
    expect(loadScenes().selectedId).toBe('');
  });

  it('远端慢响应不会覆盖同步期间保存的同 ID 本地编辑', async () => {
    const remote =
      deferred<
        Array<{ id: string; name: string; payload: { prompt: string }; deleted: boolean }>
      >();
    syncMocks.pullContent.mockImplementationOnce(() => remote.promise);
    saveScenes({
      ...emptyLibrary(),
      scenes: [{ id: 'scene-1', name: '场景', prompt: '本地旧版本' }],
    });

    const syncing = syncScenes();
    saveScenes({
      ...emptyLibrary(),
      scenes: [{ id: 'scene-1', name: '场景', prompt: '同步期间的新版本' }],
    });
    remote.resolve([
      { id: 'scene-1', name: '场景', payload: { prompt: '远端旧版本' }, deleted: false },
    ]);
    await syncing;

    expect(loadScenes().scenes[0]?.prompt).toBe('同步期间的新版本');
  });

  it('same-account profile refresh does not clear a pending local edit', async () => {
    const remote =
      deferred<
        Array<{ id: string; name: string; payload: { prompt: string }; deleted: boolean }>
      >();
    syncMocks.pullContent.mockImplementationOnce(() => remote.promise);
    const syncing = syncScenes();
    saveScenes({
      ...emptyLibrary(),
      scenes: [{ id: 'scene-1', name: '场景', prompt: '新的本地编辑' }],
    });
    window.dispatchEvent(new Event('0xnullai:auth-changed'));
    remote.resolve([
      { id: 'scene-1', name: '场景', payload: { prompt: '过期远端版本' }, deleted: false },
    ]);
    await syncing;
    expect(loadScenes().scenes[0]?.prompt).toBe('新的本地编辑');
  });

  it('登录身份在拉取期间变化时会为新账户重新同步', async () => {
    const firstPull =
      deferred<
        Array<{ id: string; name: string; payload: { prompt: string }; deleted: boolean }>
      >();
    syncMocks.pullContent
      .mockImplementationOnce(() => firstPull.promise)
      .mockResolvedValueOnce([
        { id: 'new-account', name: '新账户', payload: { prompt: '新数据' }, deleted: false },
      ]);

    const staleSync = syncScenes();
    auth.account = 'bob';
    window.dispatchEvent(new Event('0xnullai:auth-changed'));
    await vi.waitFor(() => expect(syncMocks.pullContent).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(loadScenes().scenes[0]?.id).toBe('new-account'));
    firstPull.resolve([
      { id: 'old-account', name: '旧账户', payload: { prompt: '旧数据' }, deleted: false },
    ]);
    await staleSync;
    expect(loadScenes().scenes[0]?.id).toBe('new-account');
  });

  it('keeps each account cache separate and never uploads another account’s cards', async () => {
    saveScenes({
      ...emptyLibrary(),
      scenes: [{ id: 'alice-card', name: 'Alice 私卡', prompt: '私有设定' }],
    });
    syncMocks.pushContent.mockClear();
    syncMocks.pullContent.mockResolvedValueOnce([
      { id: 'bob-card', name: 'Bob 卡', payload: { prompt: 'Bob 设定' }, deleted: false },
    ]);
    auth.account = 'bob';
    window.dispatchEvent(new Event('0xnullai:auth-changed'));
    expect(loadScenes().scenes).toEqual([]);
    await syncScenes();
    expect(loadScenes().scenes.map((scene) => scene.id)).toEqual(['bob-card']);
    expect(syncMocks.pushContent).not.toHaveBeenCalledWith([
      expect.objectContaining({ id: 'alice-card' }),
    ]);
    auth.account = 'alice';
    window.dispatchEvent(new Event('0xnullai:auth-changed'));
    expect(loadScenes().scenes.map((scene) => scene.id)).toEqual(['alice-card']);
  });

  it('uploads only the edited card and does not rewrite unrelated card or preferences', () => {
    saveScenes({
      scenes: [
        { id: 'first', name: '一', prompt: '旧内容' },
        { id: 'second', name: '二', prompt: '独立内容' },
      ],
      selectedId: 'first',
      hiddenBuiltinIds: [],
    });
    syncMocks.pushContent.mockClear();
    syncMocks.pushContentPreferences.mockClear();
    saveScenes({
      scenes: [
        { id: 'first', name: '一', prompt: '新内容' },
        { id: 'second', name: '二', prompt: '独立内容' },
      ],
      selectedId: 'first',
      hiddenBuiltinIds: [],
    });
    expect(syncMocks.pushContent).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'first', order: 0 }),
    ]);
    expect(syncMocks.pushContentPreferences).not.toHaveBeenCalled();
  });
});

describe('character metadata persistence', () => {
  const characterCard = {
    schemaVersion: 1 as const,
    description: '公开人设',
    personality: '温和',
    greeting: '你好',
    exampleDialogue: '用户：你好。角色：今天怎么样？',
    tags: ['陪伴'],
    creator: '作者',
    license: 'MIT',
  };

  it('preserves character metadata through save, local reload and account upload', () => {
    saveScenes({
      ...emptyLibrary(),
      scenes: [{ id: 'card', name: '角色', prompt: '设定', characterCard }],
    });
    expect(loadScenes().scenes[0]?.characterCard).toEqual(characterCard);
    expect(syncMocks.pushContent).toHaveBeenCalledWith([
      expect.objectContaining({ payload: { prompt: '设定', characterCard } }),
    ]);
  });

  it('preserves metadata from account download and Market import without importing private fields', async () => {
    syncMocks.pullContent.mockResolvedValueOnce([
      {
        id: 'remote-card',
        name: '角色',
        payload: { prompt: '设定', characterCard: { ...characterCard, memory: '私密' } },
        deleted: false,
      },
    ]);
    await syncScenes();
    expect(loadScenes().scenes[0]?.characterCard).toEqual(characterCard);
    const imported = withImportedMarketScene(emptyLibrary(), {
      id: 'card',
      type: 'scenario',
      name: '角色',
      content: { prompt: '设定', characterCard },
    });
    expect(imported.scenes[0]?.characterCard).toEqual(characterCard);
  });

  it('does not discard a legacy scene when optional character metadata is invalid', () => {
    localStorage.setItem(
      '0xnullai.scenes:alice',
      JSON.stringify({
        ...emptyLibrary(),
        scenes: [
          { id: 'old', name: '旧场景', prompt: '完整正文', characterCard: { schemaVersion: 99 } },
        ],
      }),
    );
    expect(loadScenes().scenes).toEqual([{ id: 'old', name: '旧场景', prompt: '完整正文' }]);
  });

  it('preserves an imported Market revision across account sync without private fields', async () => {
    const imported = withImportedMarketScene(emptyLibrary(), {
      id: 'card',
      revision: 4,
      type: 'scenario',
      name: '角色',
      content: { prompt: '设定', memory: '私密' },
    });
    saveScenes(imported);
    expect(loadScenes().scenes[0]?.marketRevision).toBe(4);
    expect(syncMocks.pushContent).toHaveBeenCalledWith([
      expect.objectContaining({
        payload: { prompt: '设定', icon: '📝', kind: 'scene', marketRevision: 4 },
      }),
    ]);
    localStorage.clear();
    __resetSceneSyncForTests();
    syncMocks.pullContent.mockResolvedValueOnce([
      {
        id: 'market-card',
        name: '角色',
        payload: { prompt: '设定', marketRevision: 4, memory: '不应同步入角色卡' },
        deleted: false,
      },
    ]);
    await syncScenes();
    expect(loadScenes().scenes[0]).toEqual({
      id: 'market-card',
      name: '角色',
      prompt: '设定',
      marketRevision: 4,
    });
  });
});

it('preserves public portrait references through import/save/sync and changes them only on explicit newer adoption', async () => {
  const first = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const second = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const item = {
    id: 'portrait-card',
    type: 'scenario',
    name: '角色',
    revision: 1,
    content: { prompt: '人设', portraitId: first, photoId: 'private-photo' },
  };
  const imported = withImportedMarketScene(emptyLibrary(), item);
  expect(imported.scenes[0]?.marketPortraitId).toBe(first);
  saveScenes(imported);
  expect(loadScenes().scenes[0]?.marketPortraitId).toBe(first);
  expect(syncMocks.pushContent.mock.calls.at(-1)?.[0][0].payload.marketPortraitId).toBe(first);
  const newer = { ...item, revision: 2, content: { prompt: '新设定', portraitId: second } };
  expect(withImportedMarketScene(imported, newer).scenes[0]?.marketPortraitId).toBe(first);
  expect(withUpdatedMarketScene(imported, newer).scenes[0]?.marketPortraitId).toBe(second);
  expect(
    withUpdatedMarketScene(imported, {
      ...newer,
      content: { prompt: '新设定', portraitId: undefined },
    }).scenes[0]?.marketPortraitId,
  ).toBeUndefined();
  __resetSceneSyncForTests();
  localStorage.clear();
  syncMocks.pullContent.mockResolvedValue([
    {
      id: 'market-portrait-card',
      name: '角色',
      payload: {
        prompt: '人设',
        marketPortraitId: first,
        marketRevision: 1,
        photoId: 'private-photo',
      },
      deleted: false,
    },
  ]);
  await syncScenes();
  expect(loadScenes().scenes[0]?.marketPortraitId).toBe(first);
  expect(JSON.stringify(loadScenes())).not.toContain('private-photo');
});
it('rejects remote URLs, malformed IDs and portrait metadata on non-Market scenes', () => {
  for (const portraitId of ['https://tracker.test/image', '../photo', 'private-photo']) {
    const imported = withImportedMarketScene(emptyLibrary(), {
      id: 'card',
      type: 'scenario',
      name: '角色',
      content: { prompt: '人设', portraitId },
    });
    expect(imported.scenes[0]?.marketPortraitId).toBeUndefined();
  }
  saveScenes({
    ...emptyLibrary(),
    scenes: [
      {
        id: 'custom',
        name: '角色',
        prompt: '人设',
        marketPortraitId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      },
    ],
  });
  expect(loadScenes().scenes[0]?.marketPortraitId).toBeUndefined();
});

describe('cards adapted from a public card', () => {
  const derivedFrom = { itemId: 'item-1', name: '雾港' };

  it('keeps derivedFrom through save, local reload, upload and download', async () => {
    saveScenes({
      ...emptyLibrary(),
      scenes: [{ id: 'mine', name: '林雾', prompt: '设定', kind: 'character', derivedFrom }],
    });
    expect(loadScenes().scenes[0]?.derivedFrom).toEqual(derivedFrom);
    expect(syncMocks.pushContent).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'mine',
        payload: { prompt: '设定', kind: 'character', derivedFrom },
      }),
    ]);
    localStorage.clear();
    __resetSceneSyncForTests();
    syncMocks.pullContent.mockResolvedValueOnce([
      {
        id: 'remote',
        name: '老周',
        payload: { prompt: '设定', kind: 'character', derivedFrom: { ...derivedFrom, extra: 1 } },
        deleted: false,
      },
    ]);
    await syncScenes();
    expect(loadScenes().scenes[0]).toEqual({
      id: 'remote',
      name: '老周',
      prompt: '设定',
      kind: 'character',
      derivedFrom,
    });
  });

  it('drops malformed derivedFrom but keeps the card (older clients have none)', () => {
    localStorage.setItem(
      '0xnullai.scenes:alice',
      JSON.stringify({
        ...emptyLibrary(),
        scenes: [
          { id: 'a', name: 'A', prompt: 'p', derivedFrom: { itemId: '../x', name: 'X' } },
          { id: 'b', name: 'B', prompt: 'p', derivedFrom: { itemId: 'ok', name: '  ' } },
          { id: 'c', name: 'C', prompt: 'p', derivedFrom: 'item-1' },
          { id: 'd', name: 'D', prompt: 'p' },
        ],
      }),
    );
    expect(loadScenes().scenes.map((scene) => [scene.id, scene.derivedFrom])).toEqual([
      ['a', undefined],
      ['b', undefined],
      ['c', undefined],
      ['d', undefined],
    ]);
  });
});

describe('account sync retries', () => {
  it('waits after a failed sync instead of retrying on every read', async () => {
    vi.useFakeTimers();
    try {
      await syncScenes();
      loadScenes();
      loadScenes();
      await syncScenes();
      expect(syncMocks.pullContent).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(31_000);
      await syncScenes();
      expect(syncMocks.pullContent).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
