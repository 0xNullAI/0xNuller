import { beforeEach, expect, it, vi } from 'vitest';
import { startSceneChat } from './start-scene-chat';

const state = vi.hoisted(() => ({
  account: 'alice',
  fetch: vi.fn(),
  import: vi.fn(),
  openScene: vi.fn(),
  downloaded: vi.fn(),
}));
vi.mock('@0xnullai/auth', () => ({ currentAuthUserId: () => state.account }));
vi.mock('@0xnullai/scenes', () => ({ importMarketSceneOnline: state.import }));
vi.mock('@0xnullai/scenes/start-chat', () => ({ openSceneChat: state.openScene }));
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
  state.openScene.mockResolvedValue(true);
});

it('imports the public scene, then opens its scene-only chat from the library', async () => {
  await startSceneChat('rain');
  expect(state.import).toHaveBeenCalledWith(scene, { restoreDeleted: true });
  expect(state.openScene).toHaveBeenCalledWith('market-rain');
  expect(state.downloaded).toHaveBeenCalledWith('rain');
});

it('reports a chat that could not open', async () => {
  state.openScene.mockResolvedValueOnce(false);
  await expect(startSceneChat('rain')).rejects.toThrow('账号已切换');
  expect(state.downloaded).not.toHaveBeenCalled();
});

it('refuses a character card and does not open a chat when the import did not select the scene', async () => {
  state.fetch.mockResolvedValueOnce({ ...scene, content: { kind: 'character', prompt: '角色' } });
  await expect(startSceneChat('rain')).rejects.toThrow('不是场景');
  state.import.mockResolvedValueOnce({ selectedId: 'someone-else' });
  await expect(startSceneChat('rain')).rejects.toThrow('场景导入失败');
  expect(state.openScene).not.toHaveBeenCalled();
});
