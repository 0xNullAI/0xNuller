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
  // The source of truth for device-safety settings is @0xnullai/settings, one
  // copy shared by the whole app. **Overlay it on every return path** — an
  // earlier version returned defaults early when this module had no local
  // storage yet, so the caps a new user set in Agent were completely invisible
  // over in Voice, and since the defaults happen to be sensible it was very
  // hard to notice.
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
  // Write the safety section back to the shared source of truth. A copy still
  // stays in this module's own blob (same shape, harmless), but reads always
  // take the shared value — when the two disagree the source of truth wins,
  // not whoever wrote last.
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
