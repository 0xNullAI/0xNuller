import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetWaveformLibrary,
  listCustomWaveforms,
  saveCustomWaveform,
  syncWaveforms,
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

beforeEach(async () => {
  for (const mock of Object.values(syncMocks)) mock.mockReset();
  syncMocks.pullContent.mockResolvedValue(null);
  syncMocks.pullContentPreferences.mockResolvedValue(null);
  syncMocks.pushContent.mockResolvedValue(undefined);
  syncMocks.pushContentPreferences.mockResolvedValue(undefined);
  await __resetWaveformLibrary();
});

describe('波形账户同步', () => {
  it('远端慢响应不会删除同步期间保存的同 ID 本地编辑', async () => {
    const remote = deferred<
      Array<{
        id: string;
        name: string;
        payload: { frames: [number, number][] };
        deleted: boolean;
      }>
    >();
    syncMocks.pullContent.mockImplementationOnce(() => remote.promise);
    await saveCustomWaveform({ id: 'wave-1', name: '波形', frames: [[1, 1]] });

    const syncing = syncWaveforms();
    await saveCustomWaveform({ id: 'wave-1', name: '波形', frames: [[9, 9]] });
    remote.resolve([{ id: 'wave-1', name: '波形', payload: { frames: [[1, 1]] }, deleted: false }]);
    await syncing;

    expect((await listCustomWaveforms())[0]?.frames).toEqual([[9, 9]]);
  });

  it('登录身份在拉取期间变化时会为新账户重新同步', async () => {
    const firstPull = deferred<
      Array<{
        id: string;
        name: string;
        payload: { frames: [number, number][] };
        deleted: boolean;
      }>
    >();
    syncMocks.pullContent
      .mockImplementationOnce(() => firstPull.promise)
      .mockResolvedValueOnce([
        { id: 'new-account', name: '新账户', payload: { frames: [[8, 8]] }, deleted: false },
      ]);

    const staleSync = syncWaveforms();
    window.dispatchEvent(new Event('0xnullai:auth-changed'));
    firstPull.resolve([
      { id: 'old-account', name: '旧账户', payload: { frames: [[1, 1]] }, deleted: false },
    ]);
    await staleSync;

    await vi.waitFor(() => expect(syncMocks.pullContent).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => expect((await listCustomWaveforms())[0]?.id).toBe('new-account'));
  });
});
