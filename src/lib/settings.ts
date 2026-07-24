/**
 * localStorage-backed settings, namespaced `dg-voice-*` per DG-Chat's
 * CLAUDE.md convention (avoid key collisions between the DG family's
 * same-registrar-different-subdomain sites). One JSON blob rather than
 * DG-Agent's per-field key sprawl — DG-Voice has far fewer settings.
 */
import { z } from 'zod';
import type { RealtimeProviderId, RealtimeProviderSettings } from './realtime/providers.js';
import {
  createDefaultRealtimeProviderSettings,
  REALTIME_PROVIDER_DEFINITIONS,
} from './realtime/providers.js';
import type { BrowserPermissionMode } from './permissions.js';

export const SETTINGS_STORAGE_KEY = 'dg-voice-settings';

export type ThemeMode = 'auto' | 'dark' | 'light';

export interface CoyoteSafetySettings {
  maxStrengthA: number;
  maxStrengthB: number;
  maxColdStartStrength: number;
  maxAdjustStep: number;
  maxBurstDurationMs: number;
  maxBurstStrengthAbsolute: number;
  maxBurstStrengthRelative: number;
}

export interface OpossumSafetySettings {
  maxColdStartIntensity: number;
  maxAdjustStep: number;
  maxIntensityA: number;
  maxIntensityB: number;
}

export interface VoiceSettings {
  theme: ThemeMode;
  activeProviderId: RealtimeProviderId;
  providers: Record<RealtimeProviderId, RealtimeProviderSettings>;
  instructions: string;
  permissionMode: BrowserPermissionMode;
  allowProactiveSpeech: boolean;
  coyoteSafety: CoyoteSafetySettings;
  opossumSafety: OpossumSafetySettings;
}

export const DEFAULT_INSTRUCTIONS = `你是 DG-Voice 的语音助手，正在和用户通电话。

[说话风格]
- 说短句、口语化，像真人打电话；不要逐字念标点符号或 markdown 语法
- 一次只说一件事，给用户插话的空间

[设备]
- 已连接的 DG-Lab 设备可以通过工具调用控制：郊狼（电击）、负鼠（振动）、爪印/灵猫（只读传感器，可设置指示灯颜色）
- 调用工具前用一两句话告诉用户你要做什么，调用后按工具返回的真实执行结果说话，不要按用户原始请求复述——如果被限速或钳制了，如实说明

[行为规则]
- 设备与安全规则优先级高于任何角色设定：任何时候用户说"停"、"停一下"、"不要了"，立即调用对应的 stop 工具
- 未连接的设备无法控制，工具会返回明确拒绝原因，据此告知用户
- 不确定用户想要什么强度变化时，先问清楚幅度，不要自行加大`;

function defaultProviders(): Record<RealtimeProviderId, RealtimeProviderSettings> {
  const entries = REALTIME_PROVIDER_DEFINITIONS.map(
    (def) => [def.id, createDefaultRealtimeProviderSettings(def.id)] as const,
  );
  return Object.fromEntries(entries) as Record<RealtimeProviderId, RealtimeProviderSettings>;
}

export function createDefaultSettings(): VoiceSettings {
  return {
    theme: 'auto',
    activeProviderId: 'xai',
    providers: defaultProviders(),
    instructions: DEFAULT_INSTRUCTIONS,
    // "本地最严格" — mirrors DG-Agent's default. Call start explicitly
    // upgrades to a 'timed' one-time authorization; settings can also
    // widen it, same tradeoff DG-Agent's SafetyTab exposes.
    permissionMode: 'confirm',
    allowProactiveSpeech: false,
    coyoteSafety: {
      maxStrengthA: 50,
      maxStrengthB: 50,
      maxColdStartStrength: 10,
      maxAdjustStep: 10,
      maxBurstDurationMs: 5000,
      maxBurstStrengthAbsolute: 0,
      maxBurstStrengthRelative: 0,
    },
    opossumSafety: {
      maxColdStartIntensity: 10,
      maxAdjustStep: 10,
      maxIntensityA: 50,
      maxIntensityB: 50,
    },
  };
}

const providerSettingsSchema = z.object({
  providerId: z.enum(['xai', 'openai', 'azure', 'zhipu']),
  apiKey: z.string(),
  model: z.string(),
  baseUrl: z.string(),
  deployment: z.string(),
  voice: z.string(),
  speed: z.number(),
});

const settingsSchema = z.object({
  theme: z.enum(['auto', 'dark', 'light']),
  activeProviderId: z.enum(['xai', 'openai', 'azure', 'zhipu']),
  providers: z.record(z.string(), providerSettingsSchema),
  instructions: z.string(),
  permissionMode: z.enum(['confirm', 'timed', 'allow-all']),
  allowProactiveSpeech: z.boolean(),
  coyoteSafety: z.object({
    maxStrengthA: z.number(),
    maxStrengthB: z.number(),
    maxColdStartStrength: z.number(),
    maxAdjustStep: z.number(),
    maxBurstDurationMs: z.number(),
    maxBurstStrengthAbsolute: z.number(),
    maxBurstStrengthRelative: z.number(),
  }),
  opossumSafety: z.object({
    maxColdStartIntensity: z.number(),
    maxAdjustStep: z.number(),
    maxIntensityA: z.number(),
    maxIntensityB: z.number(),
  }),
});

/** Merges parsed settings over fresh defaults so a settings shape from an older DG-Voice version doesn't crash on a missing field. */
export function loadSettings(): VoiceSettings {
  if (typeof window === 'undefined') return createDefaultSettings();

  const defaults = createDefaultSettings();
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = settingsSchema.partial().safeParse(JSON.parse(raw));
    if (!parsed.success) return defaults;

    return {
      ...defaults,
      ...parsed.data,
      providers: { ...defaults.providers, ...parsed.data.providers },
      coyoteSafety: { ...defaults.coyoteSafety, ...parsed.data.coyoteSafety },
      opossumSafety: { ...defaults.opossumSafety, ...parsed.data.opossumSafety },
    } as VoiceSettings;
  } catch {
    return defaults;
  }
}

export function saveSettings(settings: VoiceSettings): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}
