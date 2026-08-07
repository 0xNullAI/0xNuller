import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { NodeWaveformLibrary } from './waveform-library.js';

const SAMPLE_PULSE = 'Dungeonlab+pulse:水滴=0,0,0,1,1/0,100';

describe('NodeWaveformLibrary', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'dg-mcp-wf-'));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('list() returns the 6 built-ins by default', async () => {
    const lib = new NodeWaveformLibrary();
    const all = await lib.list();
    const ids = all.map((w) => w.id);
    expect(ids).toEqual(expect.arrayContaining(['breath', 'tide', 'pulse_low', 'pulse_mid', 'pulse_high', 'tap']));
    expect(all.length).toBe(6);
  });

  it('getById() returns null for unknown ids', async () => {
    const lib = new NodeWaveformLibrary();
    expect(await lib.getById('does-not-exist')).toBeNull();
  });

  it('getById() returns a built-in waveform with frames', async () => {
    const lib = new NodeWaveformLibrary();
    const w = await lib.getById('breath');
    expect(w).not.toBeNull();
    expect(w!.id).toBe('breath');
    expect(w!.frames.length).toBeGreaterThan(0);
  });

  it('save() adds a custom waveform that list() returns', async () => {
    const lib = new NodeWaveformLibrary();
    await lib.save({
      id: 'custom-test',
      name: '测试波形',
      description: 'unit test',
      frames: [
        [10, 30],
        [10, 60],
      ],
    });
    const found = await lib.getById('custom-test');
    expect(found?.name).toBe('测试波形');
    expect((await lib.list()).length).toBe(7);
  });

  it('importPath() parses a single .pulse file', async () => {
    const path = join(tmp, 'sample.pulse');
    await writeFile(path, SAMPLE_PULSE, 'utf8');
    const lib = new NodeWaveformLibrary();
    const result = await lib.importPath(path);
    expect(result.errors).toEqual([]);
    expect(result.loaded.length).toBe(1);
    const all = await lib.list();
    expect(all.length).toBe(7);
  });

  it('importPath() handles a .zip with multiple .pulse files', async () => {
    const path = join(tmp, 'pack.zip');
    const zipped = zipSync({
      'a.pulse': strToU8(SAMPLE_PULSE),
      'sub/b.pulse': strToU8(SAMPLE_PULSE),
      'README.md': strToU8('not a pulse — should be skipped'),
    });
    await writeFile(path, zipped);
    const lib = new NodeWaveformLibrary();
    const result = await lib.importPath(path);
    expect(result.errors).toEqual([]);
    expect(result.loaded.length).toBe(2);
  });

  it('importPath() collects errors for invalid pulse files', async () => {
    const path = join(tmp, 'broken.pulse');
    await writeFile(path, 'not a pulse format', 'utf8');
    const lib = new NodeWaveformLibrary();
    const result = await lib.importPath(path);
    expect(result.loaded.length).toBe(0);
    expect(result.errors.length).toBe(1);
  });

  it('persists custom waveforms when persistDir is set', async () => {
    const persistDir = join(tmp, 'lib');
    const lib1 = new NodeWaveformLibrary({ persistDir });
    await lib1.save({
      id: 'persist-me',
      name: 'persist',
      description: '',
      frames: [[10, 50]],
    });

    // The JSON file should now exist
    const jsonPath = join(persistDir, 'waveforms.json');
    expect(existsSync(jsonPath)).toBe(true);
    const raw = await readFile(jsonPath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.find((w: { id: string }) => w.id === 'persist-me')).toBeTruthy();

    // A fresh library reading from same dir picks it up
    const lib2 = new NodeWaveformLibrary({ persistDir });
    await lib2.init();
    const found = await lib2.getById('persist-me');
    expect(found?.name).toBe('persist');
  });

  it('init() with no persisted file is a no-op', async () => {
    const persistDir = join(tmp, 'empty-lib');
    await mkdir(persistDir, { recursive: true });
    const lib = new NodeWaveformLibrary({ persistDir });
    await expect(lib.init()).resolves.not.toThrow();
    expect((await lib.list()).length).toBe(6);
  });
});
