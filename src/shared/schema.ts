import { z } from 'zod';

// 与 DG-Agent / @dg-kit 的数据结构对齐：
//   波形 WaveformDefinition.frames = [编码频率(10..240), 强度(0..100)][]
//   场景 SavedPromptPreset = { name, icon?, prompt }
// 市场只存可移植的核心字段，导入端自行补 id。

export const WaveFrameSchema = z.tuple([
  z.number().int().min(10).max(240), // 编码后频率
  z.number().int().min(0).max(100), // 强度
]);

export const WaveformContentSchema = z.object({
  frames: z.array(WaveFrameSchema).min(1).max(5000),
  // 可选保留原始 .pulse 文本，便于在其它 DG-Lab 工具里复用。
  pulse: z.string().max(20000).optional(),
});

export const ScenarioContentSchema = z.object({
  prompt: z.string().min(1).max(12000),
});

// 多人场景：世界观 + 一组角色 + 玩法元数据（人数、AI 参与方式）。
export const MultiSceneRoleSchema = z.object({
  name: z.string().trim().min(1).max(40),
  // 角色描述 / 人设：展示给成员，也作为该角色交给 AI 时的人设（导入 DG-Chat 用）。
  description: z.string().trim().max(2000).optional(),
  // 该角色是否可由 AI 扮演。
  aiPlayable: z.boolean().optional(),
});

export const MultiSceneContentSchema = z.object({
  setting: z.string().trim().min(1).max(8000), // 世界观 / 背景
  roles: z.array(MultiSceneRoleSchema).min(1).max(12),
  // 建议玩家人数。
  playerCount: z
    .object({
      min: z.number().int().min(1).max(50),
      max: z.number().int().min(1).max(50),
    })
    .optional(),
  // AI 参与方式：none 纯人 / solo 单个 AI / multi 多个 AI 角色。
  aiMode: z.enum(['none', 'solo', 'multi']).optional(),
});

const baseFields = {
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(500).optional(),
  author: z.string().trim().max(30).optional(),
  tags: z.array(z.string().trim().min(1).max(20)).max(6).optional(),
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

// 批量上传：一次提交多条（最多 50）。公开可用，不再有人机验证。
export const BatchUploadSchema = z.array(UploadSchema).min(1).max(50);
export type BatchUploadPayload = z.infer<typeof BatchUploadSchema>;

// 管理员编辑：仅元数据，全部可选；传空串/空数组表示清空该字段。
export const AdminPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    description: z.string().trim().max(500).optional(),
    author: z.string().trim().max(30).optional(),
    icon: z.string().trim().max(8).optional(),
    tags: z.array(z.string().trim().min(1).max(20)).max(6).optional(),
  })
  .refine((p) => Object.keys(p).length > 0, { message: '没有要修改的字段' });
export type AdminPatch = z.infer<typeof AdminPatchSchema>;

export type ItemType = 'waveform' | 'scenario' | 'multi-scene';
export type WaveformContent = z.infer<typeof WaveformContentSchema>;
export type ScenarioContent = z.infer<typeof ScenarioContentSchema>;
export type MultiSceneContent = z.infer<typeof MultiSceneContentSchema>;
export type UploadPayload = z.infer<typeof UploadSchema>;

// 列表/详情接口返回给前端的形状。
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
