import { beforeEach, expect, it, vi } from 'vitest';
import { __resetSceneSyncForTests, loadScenes, saveScenes } from './index.js';
import { openSceneChat } from './start-scene-chat.js';

const state = vi.hoisted(() => ({
  account: 'alice' as string | null,
  list: vi.fn(),
  open: vi.fn(),
  select: vi.fn(),
}));
vi.mock('@0xnullai/auth', () => ({
  currentAuthUserId: () => state.account,
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

it('reopens the latest chat in that scene with no character, not a character chat in it', async () => {
  state.list.mockResolvedValue({
    items: [
      { id: 'with-character', metadata: { sceneId: 'private-rain', promptPresetId: 'xiaoye' } },
      { id: 'scene-only', metadata: { sceneId: 'private-rain' } },
    ],
  });
  await openSceneChat('private-rain');
  expect(state.select).toHaveBeenCalledWith('scene-only');
  expect(state.open).not.toHaveBeenCalled();
});

it('opens nothing for a character, a missing card, or a changed account', async () => {
  await expect(openSceneChat('xiaoye')).resolves.toBe(false);
  await expect(openSceneChat('gone')).resolves.toBe(false);
  state.list.mockImplementationOnce(async () => {
    state.account = 'bob';
    return { items: [] };
  });
  await expect(openSceneChat('private-rain')).resolves.toBe(false);
  expect(state.open).not.toHaveBeenCalled();
  expect(state.select).not.toHaveBeenCalled();
});
