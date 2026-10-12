import { parseCharacterCard, type CharacterCard } from './character-card.js';
import { parseExternalCardArchive, type ExternalCardArchive } from './external-character-card.js';
export {
  importExternalCardJson,
  MAX_EXTERNAL_CARD_BYTES,
  parseExternalCardArchive,
} from './external-character-card.js';
export type { ExternalCardArchive, ImportedExternalCard } from './external-character-card.js';

/** Online editor state, intentionally excluding private relationships and memories. */
export interface CharacterDraft {
  kind?: 'character' | 'scene';
  name: string;
  prompt: string;
  description: string;
  icon: string;
  tags: string[];
  card: CharacterCard;
  sourceArchive?: ExternalCardArchive;
  /** Owner-only Market R2 original; never copied into public scenario content. */
  sourceFileId?: string;
  sourceFileName?: string;
  portraitId?: string;
}

export const MAX_CHARACTER_PROMPT_LENGTH = 100_000;

export function parseCharacterDraft(value: unknown): CharacterDraft | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const card = parseCharacterCard(raw.card);
  const sourceArchive =
    raw.sourceArchive === undefined ? undefined : parseExternalCardArchive(raw.sourceArchive);
  const portraitId = raw.portraitId;
  const sourceFileId = raw.sourceFileId;
  const sourceFileName = raw.sourceFileName;
  if (
    (raw.kind !== undefined && raw.kind !== 'character' && raw.kind !== 'scene') ||
    typeof raw.name !== 'string' ||
    raw.name.length > 60 ||
    typeof raw.prompt !== 'string' ||
    raw.prompt.length > MAX_CHARACTER_PROMPT_LENGTH ||
    typeof raw.description !== 'string' ||
    raw.description.length > 500 ||
    typeof raw.icon !== 'string' ||
    raw.icon.length > 8 ||
    !Array.isArray(raw.tags) ||
    raw.tags.length > 20 ||
    raw.tags.some((tag) => typeof tag !== 'string' || tag.length > 20) ||
    !card ||
    (portraitId !== undefined &&
      (typeof portraitId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(portraitId))) ||
    (raw.sourceArchive !== undefined && !sourceArchive) ||
    (sourceFileId !== undefined &&
      (typeof sourceFileId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sourceFileId) ||
        !sourceArchive)) ||
    (sourceFileName !== undefined &&
      (typeof sourceFileName !== 'string' ||
        sourceFileName.length < 1 ||
        sourceFileName.length > 120 ||
        sourceFileName.includes('/') ||
        sourceFileName.includes('\\') ||
        [...sourceFileName].some(
          (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
        ))) ||
    (sourceFileId === undefined) !== (sourceFileName === undefined)
  )
    return undefined;
  return {
    ...(raw.kind === 'character' || raw.kind === 'scene' ? { kind: raw.kind } : {}),
    name: raw.name,
    prompt: raw.prompt,
    description: raw.description,
    icon: raw.icon,
    tags: [...raw.tags] as string[],
    card,
    ...(typeof portraitId === 'string' ? { portraitId } : {}),
    ...(sourceArchive ? { sourceArchive } : {}),
    ...(typeof sourceFileId === 'string' && typeof sourceFileName === 'string'
      ? { sourceFileId, sourceFileName }
      : {}),
  };
}
