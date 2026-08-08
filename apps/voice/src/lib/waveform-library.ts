import { createStore, get, set, type UseStore } from 'idb-keyval';
import type { WaveformDefinition, WaveformLibrary } from '@dg-kit/core';
import { createBasicWaveformLibrary } from '@dg-kit/waveforms';
import { z } from 'zod';

const CUSTOM_WAVEFORMS_KEY = 'custom-waveforms';

const waveformSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  frames: z.array(z.tuple([z.number(), z.number()])).min(1),
});

/**
 * IndexedDB-backed `WaveformLibrary` — built-ins from `@dg-kit/waveforms`
 * plus AI-designed waveforms persisted locally (so `design_wave` has
 * somewhere to write to; without a `save()` implementation the tool
 * throws). Mirrors DG-Agent's `BrowserWaveformLibrary` shape.
 */
export class BrowserWaveformLibrary implements WaveformLibrary {
  private readonly builtins = createBasicWaveformLibrary();
  private readonly store: UseStore;

  constructor(dbName = 'dg-voice-waveforms', storeName = 'waveforms') {
    this.store = createStore(dbName, storeName);
  }

  async getById(id: string): Promise<WaveformDefinition | null> {
    const builtin = await this.builtins.getById(id);
    if (builtin) return builtin;
    const custom = await this.readCustom();
    return custom.find((w) => w.id === id) ?? null;
  }

  async list(): Promise<WaveformDefinition[]> {
    const [builtins, custom] = await Promise.all([this.builtins.list(), this.readCustom()]);
    return [...builtins, ...custom];
  }

  async save(waveform: WaveformDefinition): Promise<void> {
    const parsed = waveformSchema.parse(waveform);
    const custom = await this.readCustom();
    const next = [...custom.filter((w) => w.id !== parsed.id), parsed];
    await set(CUSTOM_WAVEFORMS_KEY, next, this.store);
  }

  async remove(id: string): Promise<void> {
    const custom = await this.readCustom();
    await set(
      CUSTOM_WAVEFORMS_KEY,
      custom.filter((w) => w.id !== id),
      this.store,
    );
  }

  private async readCustom(): Promise<WaveformDefinition[]> {
    try {
      const raw = await get<unknown>(CUSTOM_WAVEFORMS_KEY, this.store);
      if (!Array.isArray(raw)) return [];
      return raw.filter(
        (item): item is WaveformDefinition => waveformSchema.safeParse(item).success,
      );
    } catch {
      return [];
    }
  }
}
