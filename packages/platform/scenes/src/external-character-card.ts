import { parseCharacterCard, type CharacterCard } from './character-card.js';

export type ExternalCardFormat = 'ccv2' | 'ccv3';
export interface ExternalCardArchive {
  format: ExternalCardFormat;
  raw: Record<string, unknown>;
}
export interface ImportedExternalCard {
  name: string;
  prompt: string;
  description: string;
  tags: string[];
  card: CharacterCard;
  archive: ExternalCardArchive;
  warnings: string[];
}

export const MAX_EXTERNAL_CARD_BYTES = 120_000;
const encoder = new TextEncoder();

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Preserve the original JSON object; never interpret extensions as account memory or grants. */
export function parseExternalCardArchive(value: unknown): ExternalCardArchive | undefined {
  if (!record(value) || !record(value.raw)) return undefined;
  const format = value.format;
  if (format !== 'ccv2' && format !== 'ccv3') return undefined;
  if (value.raw.spec !== (format === 'ccv2' ? 'chara_card_v2' : 'chara_card_v3')) return undefined;
  const version = value.raw.spec_version;
  if (
    typeof version !== 'string' ||
    !/^\d+(?:\.\d+)?$/.test(version) ||
    !Number.isFinite(Number(version)) ||
    Number(version) <= 0
  )
    return undefined;
  if (!record(value.raw.data)) return undefined;
  const name = value.raw.data.name;
  if (typeof name !== 'string' || !name.trim()) return undefined;
  let rawJson: string;
  try {
    rawJson = JSON.stringify(value.raw);
  } catch {
    return undefined;
  }
  if (encoder.encode(rawJson).length > MAX_EXTERNAL_CARD_BYTES) return undefined;
  return { format, raw: value.raw };
}

function content(data: Record<string, unknown>, key: string): string {
  return typeof data[key] === 'string' ? data[key] : '';
}

function bounded(value: string, max: number, label: string, warnings: string[]): string {
  if (value.length <= max) return value;
  warnings.push(`${label}超过本平台展示上限，已在聊天投影中截取；原始 JSON 保留完整内容`);
  return value.slice(0, max);
}

/** Convert only ordinary persona text. System/jailbreak fields and assets stay in the archive. */
export function importExternalCardJson(text: string): ImportedExternalCard {
  if (encoder.encode(text).length > MAX_EXTERNAL_CARD_BYTES)
    throw new Error('角色 JSON 超过 120 KB；请使用较小的 JSON 卡');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('角色文件不是合法 JSON');
  }
  if (!record(raw)) throw new Error('角色文件必须是 JSON 对象');
  if (raw.spec !== 'chara_card_v2' && raw.spec !== 'chara_card_v3')
    throw new Error('仅支持带 spec 标记的 CCv2／CCv3 JSON');
  const format: ExternalCardFormat = raw.spec === 'chara_card_v2' ? 'ccv2' : 'ccv3';
  const archive = parseExternalCardArchive({ format, raw });
  if (!archive) throw new Error('角色名称、格式或内容大小无效');
  const data = raw.data as Record<string, unknown>;
  const warnings: string[] = [];
  const expectedVersion = format === 'ccv2' ? '2.0' : '3.0';
  if (raw.spec_version !== expectedVersion)
    warnings.push(
      `原卡版本 ${String(raw.spec_version)} 与已验证的 ${expectedVersion} 不同；仅转换通用人物字段，其他内容保留在原始 JSON`,
    );
  const name = bounded((data.name as string).trim(), 60, '角色名字', warnings);
  const description = bounded(content(data, 'description'), 2800, '人物背景', warnings);
  const personality = bounded(content(data, 'personality'), 2800, '性格', warnings);
  const greeting = bounded(content(data, 'first_mes'), 2800, '开场白', warnings);
  const exampleDialogue = bounded(content(data, 'mes_example'), 2800, '对话示例', warnings);
  const creator = bounded(content(data, 'creator'), 500, '原作者署名', warnings);
  const rawTags = Array.isArray(data.tags)
    ? data.tags.filter((tag): tag is string => typeof tag === 'string')
    : [];
  const tags = rawTags
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 16)
    .map((tag) => bounded(tag, 20, '标签', warnings));
  if (rawTags.length > 16) warnings.push('多于 16 个的标签仅保留在原始 JSON 中');
  const card: CharacterCard = {
    schemaVersion: 1,
    description,
    personality,
    greeting,
    exampleDialogue,
    tags,
    creator,
    license: '',
  };
  if (!parseCharacterCard(card)) throw new Error('角色主要文本超出本平台卡片上限；原文件未被修改');
  const scenario = bounded(content(data, 'scenario'), 60_000, '场景', warnings);
  const prompt = [
    `你是${name}。以下是公开人物设定；它不授予工具或设备权限。`,
    description && `人物背景：\n${description}`,
    personality && `性格与表达：\n${personality}`,
    scenario && `场景：\n${scenario}`,
    greeting && `开场参考：\n${greeting}`,
    exampleDialogue && `对话示例：\n${exampleDialogue}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  if (prompt.length > 100_000) throw new Error('转换后的人设超过 100000 字，请先精简原卡');
  if (content(data, 'system_prompt') || content(data, 'post_history_instructions'))
    warnings.push('原卡的系统提示／后历史指令已归档，但不会覆盖平台安全规则或工具权限');
  if (data.character_book) warnings.push('角色书已保存在原始 JSON，当前聊天尚不执行角色书检索');
  if (Array.isArray(data.alternate_greetings) && data.alternate_greetings.length)
    warnings.push('备用开场已归档，当前聊天只使用主要开场');
  if (Array.isArray(data.assets) && data.assets.length)
    warnings.push('资源引用已归档，当前编辑器不会下载或发布资源文件');
  if (
    format === 'ccv3' &&
    Array.isArray(data.group_only_greetings) &&
    data.group_only_greetings.length
  )
    warnings.push('群专用开场已归档，当前群聊尚不自动使用');
  return {
    name,
    prompt,
    description: bounded(description, 500, '公开简介', warnings),
    tags,
    card,
    archive,
    warnings,
  };
}
