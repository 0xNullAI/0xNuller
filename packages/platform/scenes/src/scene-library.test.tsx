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
beforeEach(() => {
  auth.account = 'alice';
  localStorage.clear();
  __resetSceneSyncForTests();
  market.fetchItem.mockReset();
  sync.pullContent.mockReset().mockResolvedValue(null);
  sync.pushContent.mockReset().mockResolvedValue(true);
  dialog.result = null;
});
afterEach(cleanup);

it('removes built-in scenes and local creation while preserving editable legacy cards', () => {
  saveScenes({
    scenes: [{ id: 'legacy-card', name: '旧自建卡', prompt: '原文' }],
    selectedId: 'gentle',
    hiddenBuiltinIds: ['dominant'],
  });
  render(<SceneLibrary />);
  expect(screen.queryByText('内置场景')).toBeNull();
  expect(screen.queryByText('内置陪伴')).toBeNull();
  expect(screen.queryByRole('button', { name: '新建场景' })).toBeNull();
  expect(screen.queryByText('原创陪伴模板')).toBeNull();
  expect(screen.getByRole('button', { name: '从 Market 导入' })).toBeTruthy();
  expect(loadScenes().selectedId).toBe('legacy-card');
  fireEvent.click(screen.getByRole('button', { name: '编辑 旧自建卡' }));
  fireEvent.change(screen.getByPlaceholderText('场景名称'), { target: { value: '保留的旧卡' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  expect(loadScenes().scenes[0]).toMatchObject({ id: 'legacy-card', name: '保留的旧卡' });
  expect(loadScenes().hiddenBuiltinIds).toEqual(['dominant']);
});

it('keeps a legacy prompt card a scene when it is edited', () => {
  saveScenes({
    scenes: [{ id: 'market-old', name: '旧场景', prompt: '原文' }],
    selectedId: '',
    hiddenBuiltinIds: [],
  });
  render(<SceneLibrary />);
  fireEvent.click(screen.getByRole('button', { name: '编辑 旧场景' }));
  // A scene has no character card to add; adding one would give it character memory.
  expect(screen.queryByText('结构化角色卡')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  expect(loadScenes().scenes[0]).toMatchObject({ id: 'market-old', kind: 'scene' });
});

it('shows a Market import entry and an honest empty state for a new account', () => {
  render(<SceneLibrary />);
  expect(screen.getByText('还没有角色或场景。可从 Market 浏览并导入公开卡。')).toBeTruthy();
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

it('shows a public scene as environment rules without character-card editing', () => {
  saveScenes({
    scenes: [{ id: 'market-valley', name: '山谷', prompt: '环境规则', kind: 'scene' }],
    selectedId: 'market-valley',
    hiddenBuiltinIds: [],
  });
  render(<SceneLibrary />);
  expect(screen.getByText('场景')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '编辑 山谷' }));
  expect(screen.queryByText('结构化角色卡')).toBeNull();
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
