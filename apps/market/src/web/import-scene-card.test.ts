import { beforeEach, expect, it, vi } from 'vitest';
import { importSceneCard } from './import-scene-card';

const state = vi.hoisted(() => ({
  account: 'alice',
  fetch: vi.fn(),
  import: vi.fn(),
  downloaded: vi.fn(),
}));
vi.mock('@0xnullai/auth', () => ({ currentAuthUserId: () => state.account }));
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
  state.import.mockResolvedValue({ selectedId: 'character' });
  state.downloaded.mockResolvedValue(undefined);
});

it('imports a visible scene online without selecting it as a character or opening chat', async () => {
  await importSceneCard('rain');
  expect(state.import).toHaveBeenCalledWith(scene, { select: false, restoreDeleted: true });
  expect(state.downloaded).toHaveBeenCalledWith('rain');
});

it('rejects a character and an account switch before any import', async () => {
  state.fetch.mockResolvedValueOnce({ ...scene, content: { kind: 'character', prompt: '角色' } });
  await expect(importSceneCard('rain')).rejects.toThrow('不是场景');
  expect(state.import).not.toHaveBeenCalled();
  state.fetch.mockImplementationOnce(async () => {
    state.account = 'bob';
    return scene;
  });
  await expect(importSceneCard('rain')).rejects.toThrow('账号已切换');
  expect(state.import).not.toHaveBeenCalled();
});

it('does not count an import that was not confirmed online', async () => {
  state.import.mockRejectedValueOnce(new Error('云端卡片暂不可用'));
  await expect(importSceneCard('rain')).rejects.toThrow('云端卡片暂不可用');
  expect(state.downloaded).not.toHaveBeenCalled();
});
