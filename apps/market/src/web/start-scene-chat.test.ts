import { beforeEach, expect, it, vi } from 'vitest';
import { startSceneChat } from './start-scene-chat';

const state = vi.hoisted(() => ({
  account: 'alice',
  fetch: vi.fn(),
  import: vi.fn(),
  open: vi.fn(),
  select: vi.fn(),
  list: vi.fn(),
  downloaded: vi.fn(),
}));
vi.mock('@0xnullai/auth', () => ({
  currentAuthUserId: () => state.account,
  requestNewAgentInboxConversation: state.open,
  selectAgentInboxConversation: state.select,
  listPrivateConversationSummaries: state.list,
}));
vi.mock('@0xnullai/scenes', () => ({ importMarketSceneOnline: state.import }));
vi.mock('./api', () => ({ fetchItem: state.fetch, markDownloaded: state.downloaded }));

const scene = {
  id: 'rain',
  type: 'scenario',
  name: '雨夜',
  content: { kind: 'scene', prompt: '窗外下雨' },
};

beforeEach(() => {
  vi.clearAllMocks();
  state.account = 'alice';
  state.fetch.mockResolvedValue(scene);
  state.import.mockResolvedValue({ selectedId: 'market-rain' });
  state.downloaded.mockResolvedValue(undefined);
  state.list.mockResolvedValue({ items: [] });
});

it('selects the scene and opens a new chat in it, with no character', async () => {
  await startSceneChat('rain');
  expect(state.import).toHaveBeenCalledWith(scene, { restoreDeleted: true });
  expect(state.open).toHaveBeenCalledOnce();
  expect(state.downloaded).toHaveBeenCalledWith('rain');
});

it('reopens the latest chat in that scene with no character, not a character chat in it', async () => {
  state.list.mockResolvedValue({
    items: [
      { id: 'with-character', metadata: { sceneId: 'market-rain', promptPresetId: 'xiaoye' } },
      { id: 'scene-only', metadata: { sceneId: 'market-rain' } },
    ],
  });
  await startSceneChat('rain');
  expect(state.select).toHaveBeenCalledWith('scene-only');
  expect(state.open).not.toHaveBeenCalled();
});

it('refuses a character card and does not open a chat when the import did not select the scene', async () => {
  state.fetch.mockResolvedValueOnce({ ...scene, content: { kind: 'character', prompt: '角色' } });
  await expect(startSceneChat('rain')).rejects.toThrow('不是场景');
  state.import.mockResolvedValueOnce({ selectedId: 'someone-else' });
  await expect(startSceneChat('rain')).rejects.toThrow('场景导入失败');
  expect(state.open).not.toHaveBeenCalled();
});
