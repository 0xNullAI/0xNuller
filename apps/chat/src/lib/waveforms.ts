/**
 * DG-Chat waveform helpers.
 *
 * Built-ins, the design compiler and the .pulse parser all live in
 * @dg-kit/waveforms (shared with DG-Agent and DG-MCP). This file keeps the
 * DG-Chat-specific bits: the `custom` flag on imported waveforms, the
 * localStorage persistence layer, and the `parseImportFile` File-input
 * wrapper used by the WaveformPanel UI.
 */

import { strFromU8, unzipSync } from 'fflate';
import {
  listBuiltinWaveforms,
  parsePulseText,
  pulseToWaveformDefinition,
} from '@dg-kit/waveforms';
import type { WaveFrame as KitWaveFrame } from '@dg-kit/core';
import type { MarketItem, MarketWaveformContent } from './market';

export type WaveFrame = KitWaveFrame;

export interface WaveformDefinition {
  id: string;
  name: string;
  description: string;
  frames: WaveFrame[];
  /** true when the waveform was imported from a user-supplied .pulse file. */
  custom?: boolean;
}

/** Six built-in waveforms shared with DG-Agent and DG-MCP. */
export const BUILTIN_WAVEFORMS: WaveformDefinition[] = listBuiltinWaveforms().map((wave) => ({
  id: wave.id,
  name: wave.name,
  description: wave.description ?? '',
  frames: wave.frames,
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
    custom: true,
  };
}

/**
 * 把 DG-Market 的波形条目映射成 DG-Chat 的 WaveformDefinition。
 *
 * 关键：market 的 frames 是 [编码频率 10-240, 强度 0-100][]，与 @dg-kit/core
 * 的 WaveFrame 完全相同，因此原样透传，不做任何数值重映射 / 缩放 / 换序，
 * 否则会把下发给电刺激设备的数值改坏。
 */
export function marketItemToWaveform(item: MarketItem): WaveformDefinition {
  const content = item.content as MarketWaveformContent;
  return {
    id: `market-${item.id}`,
    name: item.name,
    description: item.description ?? '',
    frames: content.frames,
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
