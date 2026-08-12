/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetWaveformLibrary,
  listCustomWaveforms,
  removeCustomWaveform,
  saveCustomWaveform,
} from './index';

/**
 * Agent stored waveforms in IndexedDB and Chat in localStorage — two libraries
 * that could not see each other, so a waveform designed in one did not exist
 * in the other. These cover the merged store and, most importantly, that
 * merging does not lose anyone's work.
 */

const wave = (id: string, name = id) => ({
  id,
  name,
  frames: [[10, 20] as [number, number]],
});

afterEach(async () => {
  await __resetWaveformLibrary();
});

describe('共享波形库', () => {
  it('存进去能读出来', async () => {
    await saveCustomWaveform(wave('a'));
    expect((await listCustomWaveforms()).map((w) => w.id)).toEqual(['a']);
  });

  it('保存时保留电击/震动类型，供设置、Chat 和 Control 共用', async () => {
    await saveCustomWaveform({ ...wave('vibration'), modality: 'vibration' });
    expect((await listCustomWaveforms())[0]?.modality).toBe('vibration');
  });

  it('同 id 覆盖而不是重复', async () => {
    await saveCustomWaveform(wave('a', '旧名字'));
    await saveCustomWaveform(wave('a', '新名字'));

    const list = await listCustomWaveforms();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('新名字');
  });

  it('新的排在前面', async () => {
    await saveCustomWaveform(wave('a'));
    await saveCustomWaveform(wave('b'));
    expect((await listCustomWaveforms()).map((w) => w.id)).toEqual(['b', 'a']);
  });

  it('删除只删指定的那个', async () => {
    await saveCustomWaveform(wave('a'));
    await saveCustomWaveform(wave('b'));

    await removeCustomWaveform('a');

    expect((await listCustomWaveforms()).map((w) => w.id)).toEqual(['b']);
  });

  it('迁移会把 Chat 的 localStorage 库并进来', async () => {
    localStorage.setItem(
      'dg-chat-custom-waveforms',
      JSON.stringify([{ id: 'chat-1', name: 'Chat 的波形', frames: [[5, 5]] }]),
    );

    expect((await listCustomWaveforms()).map((w) => w.id)).toContain('chat-1');
    localStorage.removeItem('dg-chat-custom-waveforms');
  });

  it('单条损坏不会拖垮整个库', async () => {
    localStorage.setItem(
      'dg-chat-custom-waveforms',
      JSON.stringify([
        { id: 'ok', name: '好的', frames: [[1, 2]] },
        { id: '', name: '', frames: [] },
      ]),
    );

    const list = await listCustomWaveforms();

    expect(list.map((w) => w.id)).toContain('ok');
    localStorage.removeItem('dg-chat-custom-waveforms');
  });
});
