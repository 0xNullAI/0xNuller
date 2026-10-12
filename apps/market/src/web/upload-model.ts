import type { CharacterCard } from '@0xnullai/scenes/character-card';
import { scriptLengthError } from './script-length';
import { strFromU8, unzipSync } from 'fflate';
import { parsePulseText } from '../shared/pulse';
import { annotateScenarioContent, type ItemType, type UploadPayload } from '../shared/schema';

export type Frame = [number, number];
export type WaveformModality = 'electrostimulation' | 'vibration';
export interface ManualUploadFields {
  type: ItemType;
  waveformModality: WaveformModality;
  name: string;
  author: string;
  description: string;
  icon: string;
  tagsText: string;
  waveInput: string;
  prompt: string;
  characterCard?: CharacterCard;
}

export function parseWaveInput(text: string): { frames: Frame[]; pulse?: string } {
  const trimmed = text.trim();
  if (/^Dungeonlab\+pulse:/i.test(trimmed)) {
    const { frames } = parsePulseText(trimmed);
    return { frames: frames as Frame[], pulse: trimmed };
  }
  const data = JSON.parse(trimmed) as unknown;
  const frames = Array.isArray(data) ? data : (data as { frames?: unknown }).frames;
  if (!Array.isArray(frames)) throw new Error('JSON 中找不到 frames 数组');
  return { frames: frames as Frame[] };
}

export async function readPulseFromFile(
  file: File,
): Promise<{ text: string; embeddedName: string }> {
  if (/\.zip$/i.test(file.name)) {
    const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
    const pulseName = Object.keys(entries).find(
      (name) => /\.pulse$/i.test(name) && !name.startsWith('__'),
    );
    if (!pulseName) throw new Error('压缩包里没有找到 .pulse 文件');
    return {
      text: strFromU8(entries[pulseName]!),
      embeddedName: pulseName.replace(/.*\//, '').replace(/\.pulse$/i, ''),
    };
  }
  return {
    text: await file.text(),
    embeddedName: file.name.replace(/\.pulse$/i, ''),
  };
}

export function createUploadTemplate(
  type: 'waveform',
  waveformModality: WaveformModality,
): unknown {
  return {
    type,
    name: '示例波形 · 渐强脉冲',
    author: '作品额外署名（可选，发布账户仍公开显示）',
    description: '由弱到强再回落的循环脉冲，适合作为前戏铺垫。',
    tags: ['渐强', '节奏感'],
    content: {
      modality: waveformModality,
      frames: [
        [10, 20],
        [15, 40],
        [20, 60],
        [25, 80],
        [20, 60],
        [15, 40],
      ],
      pulse: '',
    },
  };
}

function baseName(name: string): string {
  return name.replace(/.*\//, '');
}

function pulseToItem(
  text: string,
  fallbackName: string,
  waveformModality: WaveformModality,
): unknown {
  const { frames, name: embedded } = parsePulseText(text);
  return {
    type: 'waveform',
    name: embedded || fallbackName,
    content: { frames, pulse: text, modality: waveformModality },
  };
}

function parseItemsJson(text: string): unknown[] {
  const data = JSON.parse(text) as unknown;
  return Array.isArray(data) ? data : [data];
}

function resolveWaveItem(
  item: Record<string, unknown>,
  pulseMap: Record<string, string>,
  used: Set<string>,
  waveformModality: WaveformModality,
): unknown {
  if (item.type !== 'waveform') return item;
  const content = (item.content ?? {}) as Record<string, unknown>;
  if (Array.isArray(content.frames) && content.frames.length) return item;
  const candidates = [
    content.pulse,
    (item as { file?: unknown }).file,
    (content as { file?: unknown }).file,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const key = baseName(candidate);
    if (pulseMap[key]) {
      used.add(key);
      const text = pulseMap[key]!;
      return {
        ...item,
        content: {
          ...content,
          frames: parsePulseText(text).frames,
          pulse: text,
          modality: content.modality ?? waveformModality,
        },
      };
    }
    if (/^Dungeonlab\+pulse:/i.test(candidate)) {
      return {
        ...item,
        content: {
          ...content,
          frames: parsePulseText(candidate).frames,
          pulse: candidate,
          modality: content.modality ?? waveformModality,
        },
      };
    }
  }
  return item;
}

export async function parseUploadFile(
  file: File,
  waveformModality: WaveformModality,
): Promise<unknown[]> {
  if (/\.zip$/i.test(file.name)) {
    const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
    const names = Object.keys(entries).filter(
      (name) => !baseName(name).startsWith('__') && !name.endsWith('/'),
    );
    const pulseMap: Record<string, string> = {};
    for (const name of names) {
      if (/\.pulse$/i.test(name)) pulseMap[baseName(name)] = strFromU8(entries[name]!);
    }
    const used = new Set<string>();
    const items: unknown[] = [];
    for (const name of names) {
      if (!/\.json$/i.test(name)) continue;
      for (const item of parseItemsJson(strFromU8(entries[name]!))) {
        items.push(
          resolveWaveItem(
            (item ?? {}) as Record<string, unknown>,
            pulseMap,
            used,
            waveformModality,
          ),
        );
      }
    }
    for (const [key, text] of Object.entries(pulseMap)) {
      if (!used.has(key)) {
        items.push(pulseToItem(text, key.replace(/\.pulse$/i, ''), waveformModality));
      }
    }
    return items;
  }
  if (/\.pulse$/i.test(file.name)) {
    return [pulseToItem(await file.text(), file.name.replace(/\.pulse$/i, ''), waveformModality)];
  }
  return parseItemsJson(await file.text()).map((item) =>
    resolveWaveItem((item ?? {}) as Record<string, unknown>, {}, new Set(), waveformModality),
  );
}

export function buildManualUploadPayload(fields: ManualUploadFields): UploadPayload {
  const lengthError = scriptLengthError(fields);
  if (lengthError) throw new Error(lengthError);
  const tags = fields.tagsText
    .split(/[,，\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 20);
  const common = {
    name: fields.name.trim(),
    description: fields.description.trim() || undefined,
    author: fields.author.trim() || undefined,
  };

  if (fields.type === 'waveform') {
    const { frames, pulse } = parseWaveInput(fields.waveInput);
    return {
      type: 'waveform',
      ...common,
      tags,
      content: { frames, pulse, modality: fields.waveformModality },
    };
  }
  if (fields.type === 'scenario') {
    if (!fields.prompt.trim()) throw new Error('请填写场景提示词');
    const scenarioTags = tags.includes('DG Agent') ? tags : ['DG Agent', ...tags].slice(0, 20);
    return {
      type: 'scenario',
      ...common,
      icon: fields.icon.trim() || undefined,
      tags: scenarioTags,
      content: annotateScenarioContent({
        prompt: fields.prompt,
        characterCard: fields.characterCard,
      }),
    };
  }
  throw new Error('内容类型不受支持');
}
