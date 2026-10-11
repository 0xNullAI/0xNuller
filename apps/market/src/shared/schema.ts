import { parseCharacterCard, type CharacterCard } from '@0xnullai/scenes/character-card';
import {
  MAX_CHARACTER_PROMPT_LENGTH,
  parseCharacterDraft,
  parseExternalCardArchive,
  type CharacterDraft,
  type ExternalCardArchive,
} from '@0xnullai/scenes/character-draft';
import { z } from 'zod';

// Aligned with the data structures in DG-Agent / @dg-kit:
//   waveform WaveformDefinition.frames = [encodedFrequency(10..240), strength(0..100)][]
//   scenario SavedPromptPreset = { name, icon?, prompt }
// The market only stores the portable core fields; the importing side supplies its own id.

export const WaveFrameSchema = z.tuple([
  z.number().int().min(10).max(240), // encoded frequency
  z.number().int().min(0).max(100), // strength
]);

export const WaveformContentSchema = z.object({
  frames: z.array(WaveFrameSchema).min(1).max(5000),
  // `electrostimulation` is the backwards-compatible default for old uploads.
  modality: z.enum(['electrostimulation', 'vibration']).optional(),
  // Optionally keep the original .pulse text so it can be reused in other DG-Lab tools.
  pulse: z.string().max(20000).optional(),
});

/**
 * Prompts up to the former limit remain ordinary scenes. Larger prompts are
 * accepted for world books and other complex setups, but are explicitly
 * annotated so clients can communicate the extra context cost before import.
 */
export const STANDARD_SCENARIO_PROMPT_LENGTH = 12_000;
export const MAX_SCENARIO_PROMPT_LENGTH = MAX_CHARACTER_PROMPT_LENGTH;
export const EXTRA_LARGE_SCENARIO_SCALE = 'extra-large' as const;
export const PromptKindSchema = z.enum(['character', 'scene']);
export type PromptKind = z.infer<typeof PromptKindSchema>;

export const CharacterCardSchema = z.unknown().transform((value, context): CharacterCard => {
  const card = parseCharacterCard(value);
  if (!card) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: '角色卡格式无效或超出内容限制' });
    return z.NEVER;
  }
  return card;
});

export const ExternalCardArchiveSchema = z
  .unknown()
  .transform((value, context): ExternalCardArchive => {
    const archive = parseExternalCardArchive(value);
    if (!archive) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: '外部角色卡原件无效或超出 120 KB' });
      return z.NEVER;
    }
    const assets = (archive.raw.data as Record<string, unknown>).assets;
    if (
      Array.isArray(assets) &&
      assets.some(
        (asset) =>
          asset &&
          typeof asset === 'object' &&
          typeof (asset as Record<string, unknown>).uri === 'string' &&
          (/^embeded:\/\//.test((asset as { uri: string }).uri) ||
            /^__asset:/.test((asset as { uri: string }).uri)),
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '原始 JSON 引用了未公开的本地附件，请仅发布人物设定',
      });
      return z.NEVER;
    }
    return archive;
  });

export const ScenarioContentSchema = z
  .object({
    prompt: z.string().min(1).max(MAX_SCENARIO_PROMPT_LENGTH),
    kind: PromptKindSchema.optional(),
    scale: z.literal(EXTRA_LARGE_SCENARIO_SCALE).optional(),
    characterCard: CharacterCardSchema.optional(),
    // null is an explicit removal in owner edits; stored content omits this field.
    sourceArchive: ExternalCardArchiveSchema.nullable().optional(),
    portraitId: z.string().uuid().nullable().optional(),
  })
  .refine((content) => content.kind !== 'scene' || !content.characterCard, {
    message: '场景不包含人物设定',
  })
  .refine((content) => content.kind !== 'character' || !!content.characterCard, {
    message: '角色需要人物设定',
  });

/** Old prompt-only cards are scenes; old structured cards are characters. */
export function promptKind(content: { kind?: PromptKind; characterCard?: unknown }): PromptKind {
  return content.kind ?? (content.characterCard ? 'character' : 'scene');
}

export function annotateScenarioContent(content: {
  prompt: string;
  kind?: PromptKind;
  characterCard?: CharacterCard;
  sourceArchive?: ExternalCardArchive | null;
  portraitId?: string | null;
}): {
  prompt: string;
  kind?: PromptKind;
  characterCard?: CharacterCard;
  sourceArchive?: ExternalCardArchive;
  portraitId?: string;
  scale?: typeof EXTRA_LARGE_SCENARIO_SCALE;
} {
  return {
    prompt: content.prompt,
    ...(content.kind ? { kind: content.kind } : {}),
    ...(content.characterCard ? { characterCard: content.characterCard } : {}),
    ...(content.sourceArchive ? { sourceArchive: content.sourceArchive } : {}),
    ...(content.portraitId ? { portraitId: content.portraitId } : {}),
    ...(content.prompt.length > STANDARD_SCENARIO_PROMPT_LENGTH
      ? { scale: EXTRA_LARGE_SCENARIO_SCALE }
      : {}),
  };
}

export function isExtraLargeScenario(content: { prompt: string; scale?: string }): boolean {
  return (
    content.scale === EXTRA_LARGE_SCENARIO_SCALE ||
    content.prompt.length > STANDARD_SCENARIO_PROMPT_LENGTH
  );
}

const baseFields = {
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(500).optional(),
  author: z.string().trim().max(30).optional(),
  tags: z.array(z.string().trim().min(1).max(20)).max(20).optional(),
};

export const UploadSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('waveform'),
    ...baseFields,
    content: WaveformContentSchema,
  }),
  z.object({
    type: z.literal('scenario'),
    ...baseFields,
    icon: z.string().trim().max(8).optional(),
    content: ScenarioContentSchema,
  }),
]);

// Batch upload: submit several items at once (at most 50). The transport requires an
// authenticated account and records every inserted id as that account's content.
export const BatchUploadSchema = z.array(UploadSchema).min(1).max(50);
export type BatchUploadPayload = z.infer<typeof BatchUploadSchema>;

// Edit an item: metadata only, everything optional; an empty string / empty array means
// clear that field.
// Authentication happens at the transport layer through account ownership.
export const ItemPatchSchema = z
  .object({
    expectedRevision: z.number().int().positive().optional(),
    name: z.string().trim().min(1).max(60).optional(),
    description: z.string().trim().max(500).optional(),
    author: z.string().trim().max(30).optional(),
    icon: z.string().trim().max(8).optional(),
    tags: z.array(z.string().trim().min(1).max(20)).max(20).optional(),
    // Scene owners may update the actual script as well as its display metadata. The
    // Worker checks this value against the stored item type before writing it, so a
    // caller cannot turn a solo scene into a multiplayer scene (or edit waveforms here).
    content: ScenarioContentSchema.optional(),
  })
  .refine((p) => Object.keys(p).some((key) => key !== 'expectedRevision'), {
    message: '没有要修改的字段',
  });
export type ItemPatch = z.infer<typeof ItemPatchSchema>;

/** Private server draft for the public card editor. No relationship or memory fields. */
export const CharacterDraftSchema = z.unknown().transform((value, context): CharacterDraft => {
  const draft = parseCharacterDraft(value);
  if (!draft) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: '角色草稿无效或超出限制' });
    return z.NEVER;
  }
  return draft;
});
export type { CharacterDraft };

export const ModerationPatchSchema = z.object({ hidden: z.boolean() }).strict();
export type ModerationPatch = z.infer<typeof ModerationPatchSchema>;

export type ItemType = 'waveform' | 'scenario';
export type WaveformContent = z.infer<typeof WaveformContentSchema>;
export type ScenarioContent = z.infer<typeof ScenarioContentSchema>;
export type UploadPayload = z.infer<typeof UploadSchema>;

// The shape the list/detail endpoints return to the frontend.
export interface MarketItem {
  verifiedCreator?: { id: string; username: string; displayName: string };
  recommendationReason?: string;
  id: string;
  type: ItemType;
  name: string;
  description?: string;
  author?: string;
  icon?: string;
  tags: string[];
  content: WaveformContent | ScenarioContent;
  downloads: number;
  views: number;
  createdAt: number;
  revision?: number;
}

export interface MarketAdminItem extends MarketItem {
  hidden: boolean;
}

export interface CharacterRevisionSummary {
  revision: number;
  name: string;
  archivedAt: number | null;
  current: boolean;
}

export interface CharacterRevisionSnapshot {
  revision: number;
  name: string;
  description?: string;
  icon?: string;
  tags: string[];
  content: ScenarioContent;
  archivedAt: number | null;
}
