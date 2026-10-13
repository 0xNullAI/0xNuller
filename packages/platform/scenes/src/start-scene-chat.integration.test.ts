import { beforeEach, expect, it, vi } from 'vitest';
import { __resetSceneSyncForTests, loadScenes, saveScenes } from './index.js';
import { openCharacterChat, openSceneChat } from './start-scene-chat.js';

const state = vi.hoisted(() => ({
  account: 'alice' as string | null,
  ensure: vi.fn(),
  list: vi.fn(),
  open: vi.fn(),
  select: vi.fn(),
}));
vi.mock('@0xnullai/auth', () => ({
  currentAuthUserId: () => state.account,
  ensureCharacterRelationship: state.ensure,
  listPrivateConversationSummaries: state.list,
  requestNewAgentInboxConversation: state.open,
  selectAgentInboxConversation: state.select,
}));
vi.mock('@0xnullai/sync', () => ({
  pullContent: vi.fn().mockResolvedValue(null),
  pullContentPreferences: vi.fn().mockResolvedValue(null),
  pushContent: vi.fn().mockResolvedValue(true),
  pushContentPreferences: vi.fn().mockResolvedValue(true),
}));

beforeEach(() => {
  vi.clearAllMocks();
  state.account = 'alice';
  localStorage.clear();
  __resetSceneSyncForTests();
  state.list.mockResolvedValue({ items: [] });
  state.ensure.mockResolvedValue({ item: {} });
  saveScenes({
    scenes: [
      { id: 'private-rain', name: '雨夜', prompt: '窗外下雨', kind: 'scene' },
      { id: 'xiaoye', name: '小夜', prompt: '人设', kind: 'character' },
    ],
    selectedId: 'xiaoye',
    hiddenBuiltinIds: [],
  });
});

it('selects a private scene and opens a new scene-only chat', async () => {
  await expect(openSceneChat('private-rain')).resolves.toBe(true);
  expect(loadScenes().selectedId).toBe('private-rain');
  expect(state.open).toHaveBeenCalledOnce();
});

it('starts a new play-through even when the scene was played before', async () => {
  state.list.mockResolvedValue({
    items: [{ id: 'scene-only', metadata: { sceneId: 'private-rain' } }],
  });
  await openSceneChat('private-rain');
  await openSceneChat('private-rain');
  expect(state.select).not.toHaveBeenCalled();
  expect(state.open).toHaveBeenCalledTimes(2);
});

it('opens nothing for a character, a missing card, or a signed-out account', async () => {
  await expect(openSceneChat('xiaoye')).resolves.toBe(false);
  await expect(openSceneChat('gone')).resolves.toBe(false);
  state.account = null;
  await expect(openSceneChat('private-rain')).resolves.toBe(false);
  state.account = 'alice';
  expect(state.open).not.toHaveBeenCalled();
  expect(state.select).not.toHaveBeenCalled();
});

it('opens a private character like a contact: its latest chat, otherwise a new one', async () => {
  saveScenes({ ...loadScenes(), selectedId: '' });
  await expect(openCharacterChat('xiaoye')).resolves.toBe(true);
  expect(state.ensure).toHaveBeenCalledWith('xiaoye');
  expect(loadScenes().selectedId).toBe('xiaoye');
  expect(state.open).toHaveBeenCalledOnce();
  state.list.mockResolvedValue({
    items: [{ id: 'chat-1', metadata: { promptPresetId: 'xiaoye' } }],
  });
  state.ensure.mockRejectedValueOnce(new Error('deleted'));
  await expect(openCharacterChat('xiaoye')).resolves.toBe(true);
  expect(state.select).toHaveBeenCalledWith('chat-1');
  state.account = null;
  await expect(openCharacterChat('xiaoye')).resolves.toBe(false);
});
