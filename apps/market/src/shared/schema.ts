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
export const MAX_SCENARIO_PROMPT_LENGTH = 100_000;
export const EXTRA_LARGE_SCENARIO_SCALE = 'extra-large' as const;

export const ScenarioContentSchema = z.object({
  prompt: z.string().min(1).max(MAX_SCENARIO_PROMPT_LENGTH),
  scale: z.literal(EXTRA_LARGE_SCENARIO_SCALE).optional(),
});

export function annotateScenarioContent(content: { prompt: string }): {
  prompt: string;
  scale?: typeof EXTRA_LARGE_SCENARIO_SCALE;
} {
  return content.prompt.length > STANDARD_SCENARIO_PROMPT_LENGTH
    ? { prompt: content.prompt, scale: EXTRA_LARGE_SCENARIO_SCALE }
    : { prompt: content.prompt };
}

export function isExtraLargeScenario(content: { prompt: string; scale?: string }): boolean {
  return (
    content.scale === EXTRA_LARGE_SCENARIO_SCALE ||
    content.prompt.length > STANDARD_SCENARIO_PROMPT_LENGTH
  );
}

// Multiplayer scene: setting + a set of roles + gameplay metadata (player count, how AI
// participates).
export const MultiSceneRoleSchema = z.object({
  name: z.string().trim().min(1).max(40),
  // Role description / persona: shown to members, and also used as the persona when this
  // role is handed to an AI (for importing into DG-Chat).
  description: z.string().trim().max(2000).optional(),
  // Whether this role can be played by an AI.
  aiPlayable: z.boolean().optional(),
});

export const MultiSceneContentSchema = z.object({
  setting: z.string().trim().min(1).max(8000), // setting / background
  roles: z.array(MultiSceneRoleSchema).min(1).max(12),
  // Suggested player count.
  playerCount: z
    .object({
      min: z.number().int().min(1).max(50),
      max: z.number().int().min(1).max(50),
    })
    .optional(),
  // How AI participates: none = humans only / solo = a single AI / multi = several AI roles.
  aiMode: z.enum(['none', 'solo', 'multi']).optional(),
});

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
  z.object({
    type: z.literal('multi-scene'),
    ...baseFields,
    icon: z.string().trim().max(8).optional(),
    content: MultiSceneContentSchema,
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
    name: z.string().trim().min(1).max(60).optional(),
    description: z.string().trim().max(500).optional(),
    author: z.string().trim().max(30).optional(),
    icon: z.string().trim().max(8).optional(),
    tags: z.array(z.string().trim().min(1).max(20)).max(20).optional(),
    // Scene owners may update the actual script as well as its display metadata. The
    // Worker checks this value against the stored item type before writing it, so a
    // caller cannot turn a solo scene into a multiplayer scene (or edit waveforms here).
    content: z.union([ScenarioContentSchema, MultiSceneContentSchema]).optional(),
  })
  .refine((p) => Object.keys(p).length > 0, { message: '没有要修改的字段' });
export type ItemPatch = z.infer<typeof ItemPatchSchema>;

export const ModerationPatchSchema = z.object({ hidden: z.boolean() }).strict();
export type ModerationPatch = z.infer<typeof ModerationPatchSchema>;

export type ItemType = 'waveform' | 'scenario' | 'multi-scene';
export type WaveformContent = z.infer<typeof WaveformContentSchema>;
export type ScenarioContent = z.infer<typeof ScenarioContentSchema>;
export type MultiSceneContent = z.infer<typeof MultiSceneContentSchema>;
export type UploadPayload = z.infer<typeof UploadSchema>;

// The shape the list/detail endpoints return to the frontend.
export interface MarketItem {
  id: string;
  type: ItemType;
  name: string;
  description?: string;
  author?: string;
  icon?: string;
  tags: string[];
  content: WaveformContent | ScenarioContent | MultiSceneContent;
  downloads: number;
  views: number;
  createdAt: number;
}

export interface MarketAdminItem extends MarketItem {
  hidden: boolean;
}
