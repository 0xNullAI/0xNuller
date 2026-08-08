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
