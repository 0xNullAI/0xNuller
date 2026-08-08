import { effectivePermissionMode, loadDeviceSafety, updateDeviceSafety } from '@0xnullai/settings';
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
import type { BrowserPermissionMode } from '@0xnullai/permissions';

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
  activeProviderId: RealtimeProviderId;
  providers: Record<RealtimeProviderId, RealtimeProviderSettings>;
  permissionMode: BrowserPermissionMode;
  allowProactiveSpeech: boolean;
  coyoteSafety: CoyoteSafetySettings;
  opossumSafety: OpossumSafetySettings;
}

function defaultProviders(): Record<RealtimeProviderId, RealtimeProviderSettings> {
  const entries = REALTIME_PROVIDER_DEFINITIONS.map(
    (def) => [def.id, createDefaultRealtimeProviderSettings(def.id)] as const,
  );
  return Object.fromEntries(entries) as Record<RealtimeProviderId, RealtimeProviderSettings>;
}

export function createDefaultSettings(): VoiceSettings {
  return {
    activeProviderId: 'xai',
    providers: defaultProviders(),
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
  providerId: z.enum(['trial', 'xai', 'openai', 'azure', 'zhipu']),
  apiKey: z.string(),
  model: z.string(),
  baseUrl: z.string(),
  deployment: z.string(),
  voice: z.string(),
  speed: z.number(),
});

const settingsSchema = z.object({
  activeProviderId: z.enum(['trial', 'xai', 'openai', 'azure', 'zhipu']),
  providers: z.record(z.string(), providerSettingsSchema),
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
  // 设备安全设置的真源在 @0xnullai/settings，全应用共用一份。**在任何返回路径上都要
  // 铺**——早期版本在「本模块还没有本地存储」时提前 return defaults，于是新用户在
  // Agent 里调的上限在 Voice 这边完全看不到，而且默认值恰好是合理的，很难被发现。
  const shared = loadDeviceSafety();
  const withShared = (base: VoiceSettings): VoiceSettings => ({
    ...base,
    coyoteSafety: {
      maxStrengthA: shared.maxStrengthA,
      maxStrengthB: shared.maxStrengthB,
      maxColdStartStrength: shared.maxColdStartStrength,
      maxAdjustStep: shared.maxAdjustStep,
      maxBurstDurationMs: shared.maxBurstDurationMs,
      maxBurstStrengthAbsolute: shared.maxBurstStrengthAbsolute,
      maxBurstStrengthRelative: shared.maxBurstStrengthRelative,
    },
    opossumSafety: {
      maxColdStartIntensity: shared.maxColdStartIntensity,
      maxAdjustStep: shared.maxOpossumAdjustStep,
      maxIntensityA: shared.maxIntensityA,
      maxIntensityB: shared.maxIntensityB,
    },
    permissionMode: effectivePermissionMode(shared),
  });

  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return withShared(defaults);
    const parsed = settingsSchema.partial().safeParse(JSON.parse(raw));
    if (!parsed.success) return withShared(defaults);

    return withShared({
      ...defaults,
      ...parsed.data,
      providers: { ...defaults.providers, ...parsed.data.providers },
    } as VoiceSettings);
  } catch {
    return withShared(defaults);
  }
}

export function saveSettings(settings: VoiceSettings): void {
  if (typeof window === 'undefined') return;
  // 安全部分写回共享真源。本模块的 blob 里仍会留一份副本（形状不变、无害），但读取
  // 时一律以共享值为准——两边不一致时以真源为准，而不是以谁最后写为准。
  updateDeviceSafety((prev) => ({
    ...prev,
    maxStrengthA: settings.coyoteSafety.maxStrengthA,
    maxStrengthB: settings.coyoteSafety.maxStrengthB,
    maxColdStartStrength: settings.coyoteSafety.maxColdStartStrength,
    maxAdjustStep: settings.coyoteSafety.maxAdjustStep,
    maxBurstDurationMs: settings.coyoteSafety.maxBurstDurationMs,
    maxBurstStrengthAbsolute: settings.coyoteSafety.maxBurstStrengthAbsolute,
    maxBurstStrengthRelative: settings.coyoteSafety.maxBurstStrengthRelative,
    maxColdStartIntensity: settings.opossumSafety.maxColdStartIntensity,
    maxOpossumAdjustStep: settings.opossumSafety.maxAdjustStep,
    maxIntensityA: settings.opossumSafety.maxIntensityA,
    maxIntensityB: settings.opossumSafety.maxIntensityB,
    permissionMode: settings.permissionMode,
  }));
  window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}
