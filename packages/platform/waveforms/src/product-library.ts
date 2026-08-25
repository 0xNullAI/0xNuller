/**
 * Product waveform helpers shared by Chat and Control.
 *
 * Built-ins, the design compiler and the .pulse parser all live in
 * @dg-kit/waveforms (shared with DG-Agent and DG-MCP). This file keeps the
 * Product UI bits: the `custom` flag on imported waveforms, the
 * localStorage persistence layer, and the `parseImportFile` File-input
 * wrapper used by the WaveformPanel UI.
 */

import { strFromU8, unzipSync } from 'fflate';
import { listBuiltinWaveforms, parsePulseText, pulseToWaveformDefinition } from '@dg-kit/waveforms';
import type {
  WaveFrame as KitWaveFrame,
  WaveformDefinition as KitWaveformDefinition,
} from '@dg-kit/core';
import type { MarketItem, MarketWaveformContent } from '@0xnullai/market-client';

export type WaveFrame = KitWaveFrame;

export type WaveformDefinition = Omit<KitWaveformDefinition, 'description'> & {
  description: string;
  /** true when the waveform was imported from a user-supplied .pulse file. */
  custom?: boolean;
};

/** Modality-aware built-ins shared with Control, Agent, Voice and MCP. */
export const BUILTIN_WAVEFORMS: WaveformDefinition[] = listBuiltinWaveforms().map((wave) => ({
  id: wave.id,
  name: wave.name,
  description: wave.description ?? '',
  frames: wave.frames,
  modality: wave.modality ?? 'electrostimulation',
}));

export function parsePulseFile(content: string): WaveformDefinition | null {
  let parsed;
  try {
    parsed = parsePulseText(content);
  } catch {
    return null;
  }
  const fallbackName = '导入波形';
  const built = pulseToWaveformDefinition(fallbackName, parsed);
  return {
    id: built.id,
    name: parsed.name || fallbackName,
    description: '从 .pulse 文件导入',
    frames: built.frames,
    modality: 'electrostimulation',
    custom: true,
  };
}

/**
 * Maps a DG-Market waveform entry onto the product UI's WaveformDefinition.
 *
 * The key point: market frames are [encoded frequency 10-240, strength 0-100][], exactly
 * the same as @dg-kit/core's WaveFrame, so they are passed through verbatim with no
 * numeric remapping / scaling / reordering — otherwise the values sent down to the
 * electrostimulation device would be corrupted.
 */
export function marketItemToWaveform(item: MarketItem): WaveformDefinition {
  const content = item.content as MarketWaveformContent;
  return {
    id: `market-${item.id}`,
    name: item.name,
    description: item.description ?? '',
    frames: content.frames,
    modality: content.modality ?? 'electrostimulation',
    custom: true,
  };
}

export async function parseImportFile(file: File): Promise<WaveformDefinition[]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const results: WaveformDefinition[] = [];

  if (/\.zip$/i.test(file.name)) {
    const entries = unzipSync(bytes);
    for (const [entryName, content] of Object.entries(entries)) {
      if (!/\.pulse$/i.test(entryName)) continue;
      const text = strFromU8(content);
      const wf = parsePulseFile(text);
      if (wf) {
        const baseName = entryName.replace(/^.*[\\/]/, '').replace(/\.pulse$/i, '') || '导入波形';
        wf.name = baseName;
        wf.id = `custom-${baseName.replace(/\W/g, '')}-${Date.now().toString(36)}-${results.length}`;
        results.push(wf);
      }
    }
  } else {
    const text = new TextDecoder().decode(bytes);
    const wf = parsePulseFile(text);
    if (wf) {
      const baseName = file.name.replace(/\.pulse$/i, '') || '导入波形';
      wf.name = baseName;
      wf.id = `custom-${baseName.replace(/\W/g, '')}-${Date.now().toString(36)}`;
      results.push(wf);
    }
  }

  return results;
}

// localStorage persistence for custom waveforms
const STORAGE_KEY = 'dg-chat-custom-waveforms';

export function loadCustomWaveforms(): WaveformDefinition[] {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return [];
    return JSON.parse(data) as WaveformDefinition[];
  } catch {
    return [];
  }
}

export function saveCustomWaveforms(waveforms: WaveformDefinition[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(waveforms));
}
