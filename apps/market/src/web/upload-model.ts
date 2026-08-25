import { strFromU8, unzipSync } from 'fflate';
import { parsePulseText } from '../shared/pulse';
import type { ItemType, UploadPayload } from '../shared/schema';

export type Frame = [number, number];
export type WaveformModality = 'electrostimulation' | 'vibration';
export type AiMode = 'none' | 'solo' | 'multi';

export interface UploadRole {
  name: string;
  description: string;
  aiPlayable: boolean;
}

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
  setting: string;
  playerMin: string;
  playerMax: string;
  aiMode: AiMode;
  roles: UploadRole[];
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

export function createUploadTemplate(type: ItemType, waveformModality: WaveformModality): unknown {
  if (type === 'waveform') {
    return {
      type: 'waveform',
      name: '示例波形 · 渐强脉冲',
      author: '你的昵称（可选，留空则匿名）',
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
  if (type === 'scenario') {
    return {
      type: 'scenario',
      name: '示例场景 · 雨夜便利店',
      author: '你的昵称（可选，留空则匿名）',
      description: '深夜值班的便利店店员，与一位常客之间的暧昧拉扯。',
      icon: '🎭',
      tags: ['DG Agent', '日常', '都市'],
      content: {
        prompt:
          '你是一家深夜便利店的店员，店里只剩你和一位每晚都来的熟客。外面下着大雨，气氛安静而暧昧。请以第一人称展开这段相遇…',
      },
    };
  }
  return {
    type: 'multi-scene',
    name: '示例多人场景 · 末日避难所',
    author: '你的昵称（可选，留空则匿名）',
    description: '资源枯竭的地下避难所里，幸存者们为生存与权力博弈。',
    icon: '🎬',
    tags: ['末日', '生存', '权谋'],
    content: {
      setting:
        '一座末日后的地下避难所，物资濒临耗尽，外面是被污染的废土。幸存者必须在猜疑与合作之间做出选择。',
      playerCount: { min: 2, max: 4 },
      aiMode: 'none',
      roles: [
        {
          name: '避难所主管',
          description: '掌握物资分配权的冷静领袖，信奉秩序高于一切。',
          aiPlayable: false,
        },
        {
          name: '流浪医生',
          description: '唯一懂医术的外来者，立场暧昧、动机成谜。',
          aiPlayable: true,
        },
      ],
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
      content: { prompt: fields.prompt.trim() },
    };
  }
  if (!fields.setting.trim()) throw new Error('请填写世界观');
  const roles = fields.roles
    .filter((role) => role.name.trim())
    .map((role) => ({
      name: role.name.trim(),
      description: role.description.trim() || undefined,
      aiPlayable: role.aiPlayable || undefined,
    }));
  if (roles.length === 0) throw new Error('至少填写一个角色');
  const min = Math.max(1, Number(fields.playerMin) || 1);
  const max = Math.max(min, Number(fields.playerMax) || min);
  return {
    type: 'multi-scene',
    ...common,
    icon: fields.icon.trim() || undefined,
    tags,
    content: {
      setting: fields.setting.trim(),
      roles,
      playerCount: { min, max },
      aiMode: fields.aiMode,
    },
  };
}
