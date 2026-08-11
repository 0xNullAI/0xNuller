import { strFromU8, unzipSync } from 'fflate';
import {
  listCustomWaveforms as sharedList,
  removeCustomWaveform as sharedRemove,
  saveCustomWaveform as sharedSave,
} from '@0xnullai/waveforms';
import type { WaveformDefinition, WaveformLibrary } from '@dg-agent/core';
import { createBasicWaveformLibrary, parsePulseText, type ParsedPulse } from '@dg-kit/waveforms';
import { z } from 'zod';

const waveformSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  frames: z.array(z.tuple([z.number(), z.number()])).min(1),
});

/**
 * Agent's view of the waveform library.
 *
 * The custom half is no longer Agent's own IndexedDB — it delegates to
 * @0xnullai/waveforms, the single shared store. Agent and Chat each kept
 * their own before, so a waveform designed in one was invisible in the
 * other; the shared module merges the old per-module stores on first read.
 *
 * The constructor still accepts the old db/store names so existing callers
 * compile unchanged; they are ignored.
 */
export class BrowserWaveformLibrary implements WaveformLibrary {
  private readonly builtins = createBasicWaveformLibrary();

  constructor(_dbName = 'dg-agent-waveforms', _storeName = 'waveforms') {}

  async getById(id: string): Promise<WaveformDefinition | null> {
    const builtin = await this.builtins.getById(id);
    if (builtin) return builtin;

    const custom = await this.getCustomWaveforms();
    return custom.find((waveform) => waveform.id === id) ?? null;
  }

  async list(): Promise<WaveformDefinition[]> {
    const [builtins, custom] = await Promise.all([this.builtins.list(), this.getCustomWaveforms()]);
    return [...builtins, ...custom];
  }

  async listCustom(): Promise<WaveformDefinition[]> {
    return this.getCustomWaveforms();
  }

  async saveCustom(waveform: WaveformDefinition): Promise<void> {
    await sharedSave(waveformSchema.parse(waveform));
  }

  /** WaveformLibrary.save — alias of saveCustom so runtime tools can write
   *  to the library without coupling to BrowserWaveformLibrary specifics. */
  async save(waveform: WaveformDefinition): Promise<void> {
    return this.saveCustom(waveform);
  }

  async removeCustom(id: string): Promise<void> {
    await sharedRemove(id);
  }

  async importFiles(files: FileList | File[]): Promise<WaveformDefinition[]> {
    const imported: WaveformDefinition[] = [];

    for (const file of Array.from(files)) {
      const bytes = new Uint8Array(await file.arrayBuffer());

      if (/\.zip$/i.test(file.name)) {
        const entries = unzipSync(bytes);
        for (const [entryName, content] of Object.entries(entries)) {
          if (!/\.pulse$/i.test(entryName)) continue;
          imported.push(createImportedWaveform(entryName, parsePulseText(strFromU8(content))));
        }
      } else {
        const text = new TextDecoder().decode(bytes);
        imported.push(createImportedWaveform(file.name, parsePulseText(text)));
      }
    }

    if (imported.length === 0) {
      throw new Error('没有找到支持的波形文件');
    }

    for (const waveform of imported) await sharedSave(waveform);
    return imported;
  }

  private async getCustomWaveforms(): Promise<WaveformDefinition[]> {
    return (await sharedList()).map((w) => cloneWaveform(w as WaveformDefinition));
  }
}

function createImportedWaveform(fileName: string, parsed: ParsedPulse): WaveformDefinition {
  // Always use the file name (basename, without extension) as the display
  // name, ignoring any name embedded inside the .pulse file.
  const basename = fileName.split('/').pop() ?? fileName;
  const displayName = basename.replace(/\.(pulse|zip)$/i, '') || basename;
  const idSeed = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const safeId = `custom-${idSeed || 'wave'}-${Date.now().toString(36)}`;
  return {
    id: safeId,
    name: displayName,
    frames: parsed.frames,
  };
}

function cloneWaveform(waveform: WaveformDefinition): WaveformDefinition {
  return {
    ...waveform,
    frames: waveform.frames.map((frame) => [frame[0], frame[1]]),
  };
}
