import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SceneLibrary } from './scene-library.js';
import { loadScenes, saveScenes, __resetSceneSyncForTests } from './index.js';
import type { MarketItem } from '@0xnullai/market-client';

const auth = vi.hoisted(() => ({ account: 'alice' as string | null }));
vi.mock('@0xnullai/auth', () => ({ currentAuthUserId: () => auth.account }));

const market = vi.hoisted(() => ({ fetchItem: vi.fn() }));
const sync = vi.hoisted(() => ({ pullContent: vi.fn(), pushContent: vi.fn() }));
const dialog = vi.hoisted(() => ({
  item: {
    id: 'card',
    type: 'scenario',
    name: '列表旧版',
    content: { prompt: '旧版' },
  } as MarketItem,
  result: null as Promise<void> | null,
}));
vi.mock('@0xnullai/market-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@0xnullai/market-client')>()),
  fetchMarketItem: market.fetchItem,
}));

vi.mock('@0xnullai/sync', () => ({
  pullContent: sync.pullContent,
  pullContentPreferences: vi.fn().mockResolvedValue(null),
  pushContent: sync.pushContent,
  pushContentPreferences: vi.fn().mockResolvedValue(true),
}));
vi.mock('@0xnullai/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@0xnullai/ui')>()),
  MarketImportDialog: ({ onImport }: { onImport: (item: MarketItem) => Promise<void> }) => (
    <button
      type="button"
      onClick={() => {
        dialog.result = onImport(dialog.item);
      }}
    >
      导入列表卡
    </button>
  ),
}));
const splitter = vi.hoisted(() => ({ source: null as unknown }));
vi.mock('./script-splitter-dialog.js', () => ({
  ScriptSplitterDialog: ({ source }: { source: unknown }) => {
    splitter.source = source;
    return <div role="dialog">拆分对话框</div>;
  },
}));
beforeEach(() => {
  splitter.source = null;
  auth.account = 'alice';
  localStorage.clear();
  __resetSceneSyncForTests();
  market.fetchItem.mockReset();
  sync.pullContent.mockReset().mockResolvedValue(null);
  sync.pushContent.mockReset().mockResolvedValue(true);
  dialog.result = null;
});
afterEach(cleanup);

it('removes built-in scenes while preserving editable legacy cards', () => {
  saveScenes({
    scenes: [{ id: 'legacy-card', name: '旧自建卡', prompt: '原文' }],
    selectedId: 'gentle',
    hiddenBuiltinIds: ['dominant'],
  });
  render(<SceneLibrary />);
  expect(screen.queryByText('内置场景')).toBeNull();
  expect(screen.queryByText('内置陪伴')).toBeNull();
  expect(screen.queryByText('原创陪伴模板')).toBeNull();
  expect(screen.getByRole('button', { name: '从 Market 导入' })).toBeTruthy();
  expect(loadScenes().selectedId).toBe('legacy-card');
  fireEvent.click(screen.getByRole('button', { name: '编辑 旧自建卡' }));
  fireEvent.change(screen.getByPlaceholderText('场景名称'), { target: { value: '保留的旧卡' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  expect(loadScenes().scenes[0]).toMatchObject({ id: 'legacy-card', name: '保留的旧卡' });
  expect(loadScenes().hiddenBuiltinIds).toEqual(['dominant']);
});

it.each([
  {
    name: 'a legacy prompt card stays a scene when edited',
    scene: { id: 'market-old', name: '旧场景', prompt: '原文' },
    selectedId: '',
  },
  {
    name: 'a public scene shows as environment rules',
    scene: { id: 'market-valley', name: '山谷', prompt: '环境规则', kind: 'scene' as const },
    selectedId: 'market-valley',
  },
])('$name, without character-card editing', ({ scene, selectedId }) => {
  saveScenes({ scenes: [scene], selectedId, hiddenBuiltinIds: [] });
  render(<SceneLibrary />);
  // The card's own type label, not the 场景 filter button.
  expect(screen.getAllByText('场景').some((element) => element.tagName !== 'BUTTON')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: `编辑 ${scene.name}` }));
  // A scene has no character card to add; adding one would give it character memory.
  expect(screen.queryByText('结构化角色卡')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  expect(loadScenes().scenes[0]).toMatchObject({ id: scene.id, kind: 'scene' });
});

it('shows a Market import entry and an honest empty state for a new account', () => {
  render(<SceneLibrary />);
  expect(screen.getByText('还没有角色或场景。可新建、导入文件，或从发现导入公开卡。')).toBeTruthy();
  expect(screen.getByRole('button', { name: '从 Market 导入' })).toBeTruthy();
  expect(loadScenes().selectedId).toBe('');
});

it('offers explicit recovery of old browser cards after checking the account', async () => {
  sync.pullContent.mockResolvedValue([]);
  localStorage.setItem(
    '0xnullai.scenes',
    JSON.stringify({
      scenes: [{ id: 'old-card', name: '旧卡', prompt: '旧设定' }],
      selectedId: 'old-card',
      hiddenBuiltinIds: [],
    }),
  );
  render(<SceneLibrary />);
  expect(screen.queryByText('旧卡')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '导入这台设备上的旧卡（1）' }));
  expect(await screen.findByText('旧卡')).toBeTruthy();
  expect(loadScenes().scenes[0]?.prompt).toBe('旧设定');
});

it('keeps old browser cards untouched when the account cannot be checked', async () => {
  localStorage.setItem(
    '0xnullai.scenes',
    JSON.stringify({
      scenes: [{ id: 'old-card', name: '旧卡', prompt: '旧设定' }],
      selectedId: 'old-card',
      hiddenBuiltinIds: [],
    }),
  );
  render(<SceneLibrary />);
  fireEvent.click(screen.getByRole('button', { name: '导入这台设备上的旧卡（1）' }));
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    '云端卡片暂不可用，旧卡仍保留在这台设备上',
  );
  expect(loadScenes().scenes).toEqual([]);
  expect(localStorage.getItem('0xnullai.scenes')).toContain('旧设定');
});

it('hides the outgoing account’s card and open editor immediately on account change', () => {
  saveScenes({
    scenes: [{ id: 'private-card', name: 'Alice 私卡', prompt: '私有设定' }],
    selectedId: 'private-card',
    hiddenBuiltinIds: [],
  });
  render(<SceneLibrary />);
  fireEvent.click(screen.getByRole('button', { name: '编辑 Alice 私卡' }));
  expect(screen.getByDisplayValue('私有设定')).toBeTruthy();
  act(() => {
    auth.account = 'bob';
    window.dispatchEvent(new Event('0xnullai:auth-changed'));
  });
  expect(screen.queryByText('Alice 私卡')).toBeNull();
  expect(screen.queryByDisplayValue('私有设定')).toBeNull();
  expect(loadScenes().scenes).toEqual([]);
});

it('imports the latest visible scene snapshot without selecting it as the chat character', async () => {
  saveScenes(
    {
      scenes: [{ id: 'my-character', name: '朋友', prompt: '角色人设', kind: 'character' }],
      selectedId: 'my-character',
      hiddenBuiltinIds: [],
    },
    true,
  );
  sync.pullContent.mockResolvedValue([]);
  market.fetchItem.mockResolvedValue({
    id: 'card',
    type: 'scenario',
    name: '最新场景',
    revision: 4,
    content: { kind: 'scene', prompt: '新版本环境规则', memory: '不得进入个人场景库' },
  });
  render(<SceneLibrary />);
  fireEvent.click(screen.getByRole('button', { name: '导入列表卡' }));
  await act(async () => {
    await dialog.result;
  });
  expect(market.fetchItem).toHaveBeenCalledWith('card');
  expect(loadScenes().selectedId).toBe('my-character');
  expect(loadScenes().scenes.find((scene) => scene.id === 'market-card')).toEqual({
    id: 'market-card',
    name: '最新场景',
    icon: '📝',
    prompt: '新版本环境规则',
    kind: 'scene',
    marketRevision: 4,
  });
  expect(JSON.stringify(loadScenes())).not.toContain('不得进入个人场景库');
});

it('imports the latest visible character version as a private chat identity', async () => {
  sync.pullContent.mockResolvedValue([]);
  market.fetchItem.mockResolvedValue({
    id: 'card',
    type: 'scenario',
    name: '小岚',
    revision: 7,
    content: {
      kind: 'character',
      prompt: '你是小岚的新设定',
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
  });
  render(<SceneLibrary />);
  fireEvent.click(screen.getByRole('button', { name: '导入列表卡' }));
  await act(async () => {
    await dialog.result;
  });
  expect(loadScenes().selectedId).toBe('market-card');
  expect(loadScenes().scenes[0]).toMatchObject({
    id: 'market-card',
    name: '小岚',
    kind: 'character',
    prompt: '你是小岚的新设定',
    marketRevision: 7,
  });
});

it('does not import a stale list card when latest detail is hidden or the account switches', async () => {
  sync.pullContent.mockResolvedValue([]);
  market.fetchItem.mockRejectedValueOnce(new Error('市场条目无法读取 (404)'));
  render(<SceneLibrary />);
  fireEvent.click(screen.getByRole('button', { name: '导入列表卡' }));
  await expect(dialog.result).rejects.toThrow('404');
  expect(loadScenes().scenes).toEqual([]);

  market.fetchItem.mockImplementationOnce(async () => {
    auth.account = 'bob';
    window.dispatchEvent(new Event('0xnullai:auth-changed'));
    return {
      id: 'card',
      type: 'scenario',
      name: '角色',
      content: { kind: 'scene', prompt: '新版' },
    };
  });
  fireEvent.click(screen.getByRole('button', { name: '导入列表卡' }));
  await expect(dialog.result).rejects.toThrow('账号已切换');
  expect(loadScenes().scenes).toEqual([]);
});

it('shows a newer public scene for explicit adoption while retaining its personal identity', async () => {
  saveScenes({
    scenes: [{ id: 'market-card', name: '小岚', prompt: '旧人设', marketRevision: 2 }],
    selectedId: 'market-card',
    hiddenBuiltinIds: [],
  });
  market.fetchItem.mockResolvedValue({
    id: 'card',
    type: 'scenario',
    revision: 3,
    name: '小岚新版',
    content: { prompt: '新人设' },
  });
  render(<SceneLibrary />);
  fireEvent.click(screen.getByRole('button', { name: '检查 小岚 的公开更新' }));
  expect(await screen.findByText('公开场景有新版本：v2 → v3')).toBeTruthy();
  expect(loadScenes().scenes[0]?.prompt).toBe('旧人设');
  fireEvent.click(screen.getByRole('button', { name: '采用新版' }));
  await waitFor(() => expect(loadScenes().scenes[0]?.prompt).toBe('新人设'));
  expect(loadScenes().scenes[0]?.id).toBe('market-card');
  expect(loadScenes().selectedId).toBe('market-card');
});

it('updates a character card without replacing its relationship identity', async () => {
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
  saveScenes({
    scenes: [
      {
        id: 'market-role',
        name: '角色',
        prompt: '旧人设',
        kind: 'character',
        characterCard: card,
        marketRevision: 2,
      },
    ],
    selectedId: 'market-role',
    hiddenBuiltinIds: [],
  });
  market.fetchItem.mockResolvedValue({
    id: 'role',
    type: 'scenario',
    revision: 3,
    name: '角色新版',
    content: { kind: 'character', prompt: '新人设', characterCard: card },
  });
  render(<SceneLibrary />);
  fireEvent.click(screen.getByRole('button', { name: '检查 角色 的公开更新' }));
  expect(await screen.findByText('公开角色有新版本：v2 → v3')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '采用新版' }));
  await waitFor(() => expect(loadScenes().scenes[0]?.prompt).toBe('新人设'));
  expect(loadScenes().scenes[0]?.id).toBe('market-role');
  expect(screen.getByText('已采用新版公开人设；专属称呼、记忆和聊天记录不变')).toBeTruthy();
});

it('discards an update result after the account changes', async () => {
  saveScenes({
    scenes: [{ id: 'market-card', name: '小岚', prompt: '旧人设', marketRevision: 2 }],
    selectedId: 'market-card',
    hiddenBuiltinIds: [],
  });
  let resolve!: (value: unknown) => void;
  market.fetchItem.mockReturnValue(new Promise((done) => (resolve = done)));
  render(<SceneLibrary />);
  fireEvent.click(screen.getByRole('button', { name: '检查 小岚 的公开更新' }));
  await waitFor(() => expect(market.fetchItem).toHaveBeenCalledOnce());
  auth.account = 'bob';
  window.dispatchEvent(new Event('0xnullai:auth-changed'));
  await act(async () => {
    resolve({
      id: 'card',
      type: 'scenario',
      revision: 3,
      name: '新版',
      content: { prompt: '新人设' },
    });
  });
  expect(screen.queryByRole('button', { name: '采用新版' })).toBeNull();
  expect(loadScenes().scenes).toEqual([]);
});

it('filters the library by type and by name', () => {
  saveScenes({
    scenes: [
      { id: 'c1', name: '小夜', prompt: '人设', kind: 'character' as const },
      { id: 's1', name: '雨夜咖啡馆', prompt: '环境', kind: 'scene' as const },
      { id: 's2', name: '海边', prompt: '环境', kind: 'scene' as const },
    ],
    selectedId: '',
    hiddenBuiltinIds: [],
  });
  render(<SceneLibrary />);
  const shown = () =>
    ['小夜', '雨夜咖啡馆', '海边'].filter((name) =>
      screen.queryByRole('button', { name: `编辑 ${name}` }),
    );
  expect(shown()).toEqual(['小夜', '雨夜咖啡馆', '海边']);
  fireEvent.click(screen.getByRole('button', { name: '角色' }));
  expect(shown()).toEqual(['小夜']);
  fireEvent.click(screen.getByRole('button', { name: '场景' }));
  expect(shown()).toEqual(['雨夜咖啡馆', '海边']);
  fireEvent.change(screen.getByRole('textbox', { name: '搜索角色与场景' }), {
    target: { value: '海' },
  });
  expect(shown()).toEqual(['海边']);
  fireEvent.change(screen.getByRole('textbox', { name: '搜索角色与场景' }), {
    target: { value: '不存在' },
  });
  expect(screen.getByText('没有匹配的卡片')).toBeTruthy();
});

it.each([
  {
    kind: 'character' as const,
    label: '新建角色',
    placeholder: '角色名称',
    prompt: '描述 AI 的人设和互动风格…',
  },
  {
    kind: 'scene' as const,
    label: '新建场景',
    placeholder: '场景名称',
    prompt: '描述环境、规则和氛围…',
  },
])('creates a private $kind in the library', ({ kind, label, placeholder, prompt }) => {
  render(<SceneLibrary />);
  fireEvent.click(screen.getByRole('button', { name: '新建' }));
  fireEvent.click(screen.getByRole('button', { name: label }));
  expect(Boolean(screen.queryByText('结构化角色卡'))).toBe(kind === 'character');
  fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value: ' 小雨 ' } });
  fireEvent.change(screen.getByPlaceholderText(prompt), { target: { value: '设定' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  const [created] = loadScenes().scenes;
  expect(created).toMatchObject({ kind, name: '小雨', prompt: '设定' });
  expect(created!.id.startsWith('market-')).toBe(false);
  expect(screen.getByText('私有')).toBeTruthy();
  // Never published: creating a card only syncs the account library.
  expect(market.fetchItem).not.toHaveBeenCalled();
});

it('imports a local CCv2 file as a private character and shows the parser warnings', async () => {
  render(<SceneLibrary />);
  const card = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '海边旧友',
      description: '住在海边',
      personality: '安静',
      first_mes: '好久不见',
      extensions: { custom: true },
    },
  };
  const file = new File([JSON.stringify(card)], 'friend.json', { type: 'application/json' });
  fireEvent.change(screen.getByLabelText('导入 CCv2／CCv3 角色文件'), {
    target: { files: [file] },
  });
  await waitFor(() => expect(loadScenes().scenes).toHaveLength(1));
  const [created] = loadScenes().scenes;
  expect(created).toMatchObject({ kind: 'character', name: '海边旧友' });
  expect(created!.prompt).toContain('住在海边');
  expect(created!.characterCard).toMatchObject({ greeting: '好久不见' });
  expect(created!.id.startsWith('market-')).toBe(false);
  expect(screen.getByRole('status').textContent).toContain('已导入角色「海边旧友」');
});

it('reports an unreadable file without adding a card', async () => {
  render(<SceneLibrary />);
  const file = new File(['not json'], 'broken.json', { type: 'application/json' });
  fireEvent.change(screen.getByLabelText('导入 CCv2／CCv3 角色文件'), {
    target: { files: [file] },
  });
  await screen.findByRole('alert');
  expect(loadScenes().scenes).toHaveLength(0);
});

it('labels where each card came from', () => {
  saveScenes({
    scenes: [
      { id: 'mine', name: '自建', prompt: '人设', kind: 'character' as const },
      { id: 'market-a', name: '公开', prompt: '人设', kind: 'scene' as const, marketRevision: 3 },
    ],
    selectedId: '',
    hiddenBuiltinIds: [],
  });
  render(<SceneLibrary />);
  expect(screen.getByText('私有')).toBeTruthy();
  expect(screen.getByText('来自发现 · v3')).toBeTruthy();
  expect(screen.queryByText(/公开卡 v/)).toBeNull();
});

it('starts a chat with the chosen card through the host callback', () => {
  const scenes = [
    { id: 'mine', name: '小夜', prompt: '人设', kind: 'character' as const },
    { id: 'market-a', name: '雨夜', prompt: '环境', kind: 'scene' as const },
  ];
  saveScenes({ scenes, selectedId: '', hiddenBuiltinIds: [] });
  const { unmount } = render(<SceneLibrary />);
  // Without a host that can open chats, the library offers no dead button.
  expect(screen.queryByRole('button', { name: '和 小夜 聊天' })).toBeNull();
  unmount();
  const onStartChat = vi.fn();
  render(<SceneLibrary onStartChat={onStartChat} />);
  fireEvent.click(screen.getByRole('button', { name: '和 雨夜 聊天' }));
  expect(onStartChat).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'market-a' }));
  fireEvent.click(screen.getByRole('button', { name: '和 小夜 聊天' }));
  expect(onStartChat).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'mine' }));
});

it('offers 拆分角色 only for long scripts and passes attribution for each source', async () => {
  const long = '剧本'.repeat(1500);
  saveScenes({
    scenes: [
      { id: 'short', name: '短卡', prompt: '人设', kind: 'character' as const },
      { id: 'mine', name: '我的剧本', prompt: long, kind: 'scene' as const },
      { id: 'market-pub', name: '公开剧本', prompt: long, kind: 'scene' as const },
      {
        id: 'adapted',
        name: '林雾',
        prompt: long,
        kind: 'scene' as const,
        derivedFrom: { itemId: 'pub', name: '雾港' },
      },
    ],
    selectedId: '',
    hiddenBuiltinIds: [],
  });
  market.fetchItem.mockResolvedValue({ id: 'pub', author: '作者甲' });
  render(<SceneLibrary />);
  expect(screen.getByText('私有 · 改编自《雾港》')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '拆分角色：短卡' })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: '拆分角色：我的剧本' }));
  expect(splitter.source).toEqual({ name: '我的剧本', prompt: long, author: '我' });

  fireEvent.click(screen.getByRole('button', { name: '拆分角色：公开剧本' }));
  await waitFor(() =>
    expect(splitter.source).toEqual({
      name: '公开剧本',
      prompt: long,
      author: '作者甲',
      derivedFrom: { itemId: 'pub', name: '公开剧本' },
    }),
  );
  expect(market.fetchItem).toHaveBeenCalledWith('pub');

  fireEvent.click(screen.getByRole('button', { name: '拆分角色：林雾' }));
  expect(splitter.source).toMatchObject({ derivedFrom: { itemId: 'pub', name: '雾港' } });
});
