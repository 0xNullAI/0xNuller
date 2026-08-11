import {
  listCustomWaveforms as sharedList,
  saveCustomWaveform as sharedSave,
} from '@0xnullai/waveforms';
import type { WaveformDefinition, WaveformLibrary } from '@dg-kit/core';
import { createBasicWaveformLibrary } from '@dg-kit/waveforms';

/**
 * Voice's view of the waveform library: built-ins from `@dg-kit/waveforms`
 * plus the custom half, which `design_wave` writes to (without a `save()`
 * implementation that tool throws).
 *
 * The custom half is no longer Voice's own IndexedDB (`dg-voice-waveforms`)
 * but @0xnullai/waveforms, the single shared store — Agent and Chat already
 * moved. A waveform the AI designed mid-call used to exist only inside Voice;
 * now it shows up in every module. The shared module merges the old
 * per-module stores on first read, and parses per item, so one corrupt row
 * still cannot take the library down.
 */
export class BrowserWaveformLibrary implements WaveformLibrary {
  private readonly builtins = createBasicWaveformLibrary();

  async getById(id: string): Promise<WaveformDefinition | null> {
    const builtin = await this.builtins.getById(id);
    if (builtin) return builtin;
    const custom = await sharedList();
    return custom.find((w) => w.id === id) ?? null;
  }

  async list(): Promise<WaveformDefinition[]> {
    const [builtins, custom] = await Promise.all([this.builtins.list(), sharedList()]);
    return [...builtins, ...custom];
  }

  async save(waveform: WaveformDefinition): Promise<void> {
    // The shared store validates on write, so no second schema here.
    await sharedSave(waveform);
  }
}
