/**
 * Node-side `WaveformLibrary` implementation.
 *
 * Wraps `@dg-kit/waveforms`'s in-memory built-ins and adds:
 * - bulk `.zip` / `.pulse` import from filesystem paths
 * - optional JSON persistence (when `persistDir` is set, design_wave outputs
 *   and imported waveforms survive process restarts)
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import type { WaveformDefinition, WaveformLibrary } from '@dg-kit/core';
import {
  createBasicWaveformLibrary,
  parsePulseText,
  pulseToWaveformDefinition,
} from '@dg-kit/waveforms';

export interface NodeWaveformLibraryOptions {
  /** Optional directory to persist user-imported and AI-designed waveforms. */
  persistDir?: string;
}

export interface ImportResult {
  loaded: Array<{ id: string; name: string; source: string }>;
  errors: Array<{ file: string; reason: string }>;
}

const PERSIST_FILENAME = 'waveforms.json';

export class NodeWaveformLibrary implements WaveformLibrary {
  private readonly builtins = createBasicWaveformLibrary();
  private readonly custom = new Map<string, WaveformDefinition>();

  constructor(private readonly options: NodeWaveformLibraryOptions = {}) {}

  /** Load persisted waveforms from disk, if `persistDir` is set. */
  async init(): Promise<void> {
    if (!this.options.persistDir) return;
    const path = join(this.options.persistDir, PERSIST_FILENAME);
    if (!existsSync(path)) return;
    try {
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw) as WaveformDefinition[];
      for (const w of parsed) {
        this.custom.set(w.id, cloneWaveform(w));
      }
    } catch {
      // corrupt file — ignore, start fresh
    }
  }

  async getById(id: string): Promise<WaveformDefinition | null> {
    const builtin = await this.builtins.getById(id);
    if (builtin) return builtin;
    const custom = this.custom.get(id);
    return custom ? cloneWaveform(custom) : null;
  }

  async list(): Promise<WaveformDefinition[]> {
    const builtins = await this.builtins.list();
    return [...builtins, ...[...this.custom.values()].map(cloneWaveform)];
  }

  async save(waveform: WaveformDefinition): Promise<void> {
    this.custom.set(waveform.id, cloneWaveform(waveform));
    await this.flush();
  }

  /** Import a single `.pulse` file path or a `.zip` containing `.pulse` files. */
  async importPath(filePath: string): Promise<ImportResult> {
    const result: ImportResult = { loaded: [], errors: [] };
    try {
      const buf = await readFile(filePath);
      if (extname(filePath).toLowerCase() === '.zip') {
        const entries = unzipSync(new Uint8Array(buf));
        for (const [entryName, content] of Object.entries(entries)) {
          if (extname(entryName).toLowerCase() !== '.pulse') continue;
          try {
            const parsed = parsePulseText(strFromU8(content));
            const wave = pulseToWaveformDefinition(entryName, parsed, { idPrefix: 'imported' });
            this.custom.set(wave.id, {
              id: wave.id,
              name: wave.name,
              description: '从 .pulse 导入',
              frames: wave.frames,
            });
            result.loaded.push({ id: wave.id, name: wave.name, source: entryName });
          } catch (e) {
            result.errors.push({ file: entryName, reason: errMsg(e) });
          }
        }
      } else {
        const text = buf.toString('utf8');
        const parsed = parsePulseText(text);
        const wave = pulseToWaveformDefinition(basename(filePath), parsed, { idPrefix: 'imported' });
        this.custom.set(wave.id, {
          id: wave.id,
          name: wave.name,
          description: '从 .pulse 导入',
          frames: wave.frames,
        });
        result.loaded.push({ id: wave.id, name: wave.name, source: basename(filePath) });
      }
    } catch (e) {
      result.errors.push({ file: filePath, reason: errMsg(e) });
    }

    if (result.loaded.length > 0) {
      await this.flush();
    }
    return result;
  }

  private async flush(): Promise<void> {
    if (!this.options.persistDir) return;
    await mkdir(this.options.persistDir, { recursive: true });
    const path = join(this.options.persistDir, PERSIST_FILENAME);
    const arr = [...this.custom.values()];
    await writeFile(path, JSON.stringify(arr, null, 2), 'utf8');
  }
}

function cloneWaveform(w: WaveformDefinition): WaveformDefinition {
  return {
    id: w.id,
    name: w.name,
    description: w.description,
    frames: w.frames.map(([f, i]) => [f, i] as [number, number]),
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
