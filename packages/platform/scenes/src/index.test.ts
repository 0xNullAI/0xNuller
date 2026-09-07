import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetSceneSyncForTests,
  loadScenes,
  saveScenes,
  syncScenes,
  withImportedMarketScene,
  type SceneLibrary,
} from './index.js';

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
});

describe('场景账户同步', () => {
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
    window.dispatchEvent(new Event('0xnullai:auth-changed'));
    firstPull.resolve([
      { id: 'old-account', name: '旧账户', payload: { prompt: '旧数据' }, deleted: false },
    ]);
    await staleSync;

    await vi.waitFor(() => expect(syncMocks.pullContent).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(loadScenes().scenes[0]?.id).toBe('new-account'));
  });
});
