import { expect, it, vi } from 'vitest';
import { CharacterStudioDraftSaver } from './CharacterStudioDraft';
import type { CharacterDraft } from '../../shared/schema';
import { emptyCharacterCard } from '@0xnullai/scenes/character-card';
const draft = (name: string): CharacterDraft => ({
  name,
  prompt: '人设',
  description: '',
  icon: '',
  tags: [],
  card: emptyCharacterCard(),
});
it('serializes snapshots against the latest successful CAS revision', async () => {
  let resolve!: (revision: number) => void;
  const write = vi
    .fn<(draft: CharacterDraft, revision: number) => Promise<number>>()
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValueOnce(5);
  const saver = new CharacterStudioDraftSaver(write);
  saver.initialize(3, null);
  const first = saver.save(draft('first'));
  const second = saver.save(draft('second'));
  await Promise.resolve();
  expect(write).toHaveBeenCalledTimes(1);
  resolve(4);
  await first;
  await second;
  expect(write.mock.calls.map((call) => [call[0].name, call[1]])).toEqual([
    ['first', 3],
    ['second', 4],
  ]);
  expect(saver.isSaved(draft('second'))).toBe(true);
});
it('does not advance CAS on conflict and pauses subsequent automatic writes', async () => {
  const write = vi.fn().mockRejectedValueOnce(new Error('409 conflict')).mockResolvedValue(8);
  const saver = new CharacterStudioDraftSaver(write);
  saver.initialize(6, null);
  await expect(saver.save(draft('local'), true)).rejects.toThrow('409');
  expect(await saver.save(draft('changed'), true)).toBeNull();
  expect(write).toHaveBeenCalledOnce();
  await saver.save(draft('retry'));
  expect(write.mock.calls[1]![1]).toBe(6);
});
it('publication pauses queued autosaves while its explicit flush can complete', async () => {
  const write = vi.fn().mockResolvedValue(1);
  const saver = new CharacterStudioDraftSaver(write);
  saver.initialize(0, null);
  const automatic = saver.save(draft('older'), true);
  saver.pause();
  const flushed = saver.save(draft('published'));
  expect(await automatic).toBeNull();
  expect(await flushed).toBe(1);
  expect(write).toHaveBeenCalledOnce();
  expect(write.mock.calls[0]![0].name).toBe('published');
});
it('never writes before loading remote state or after account invalidation', async () => {
  const write = vi.fn();
  const saver = new CharacterStudioDraftSaver(write);
  await expect(saver.save(draft('early'))).rejects.toThrow('尚未读取');
  saver.initialize(0, null);
  const queued = saver.save(draft('old account'));
  saver.dispose();
  await expect(queued).rejects.toThrow('账户已切换');
  expect(write).not.toHaveBeenCalled();
});
