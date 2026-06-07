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
    turnstileToken: z.string().min(1),
  }),
  z.object({
    type: z.literal('scenario'),
    ...baseFields,
    icon: z.string().trim().max(8).optional(),
    content: ScenarioContentSchema,
    turnstileToken: z.string().min(1),
  }),
]);

export type ItemType = 'waveform' | 'scenario';
export type WaveformContent = z.infer<typeof WaveformContentSchema>;
export type ScenarioContent = z.infer<typeof ScenarioContentSchema>;
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
  content: WaveformContent | ScenarioContent;
  downloads: number;
  views: number;
  createdAt: number;
}
