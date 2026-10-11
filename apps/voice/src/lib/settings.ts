import { readPreference, writePreference } from '@0xnullai/settings';
import {
  loadDeviceSafetySections,
  saveDeviceSafetySections,
  type CoyoteSafetySettings,
  type OpossumSafetySettings,
} from '@0xnullai/settings';
/**
 * localStorage-backed settings, namespaced `dg-voice-*` per DG-Chat's
 * CLAUDE.md convention (avoid key collisions between the DG family's
 * same-registrar-different-subdomain sites). One JSON blob rather than
 * DG-Agent's per-field key sprawl — DG-Voice has far fewer settings.
 */
import { z } from 'zod';
import { DEFAULT_MANAGED_VOICE, normalizeManagedVoice } from './realtime/managed-voices.js';
import type { BrowserPermissionMode } from '@0xnullai/permissions';

export const SETTINGS_STORAGE_KEY = 'dg-voice-settings';

export type ThemeMode = 'auto' | 'dark' | 'light';

export type { CoyoteSafetySettings, OpossumSafetySettings } from '@0xnullai/settings';

export interface VoiceSettings {
  /** Account default voice for 猫愿语音; a character relationship may override it per call. */
  voice: string;
  permissionMode: BrowserPermissionMode;
  coyoteSafety: CoyoteSafetySettings;
  opossumSafety: OpossumSafetySettings;
}

export function createDefaultSettings(): VoiceSettings {
  return {
    voice: DEFAULT_MANAGED_VOICE,
    // "本地最严格" — mirrors DG-Agent's default. Call start explicitly
    // upgrades to a 'timed' one-time authorization; settings can also
    // widen it, same tradeoff DG-Agent's SafetyTab exposes.
    permissionMode: 'confirm',
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

const settingsSchema = z.object({
  permissionMode: z.enum(['confirm', 'timed', 'allow-all']),
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
  const shared = loadDeviceSafetySections();
  const withShared = (base: VoiceSettings): VoiceSettings => ({
    ...base,
    coyoteSafety: shared.coyoteSafety,
    opossumSafety: shared.opossumSafety,
    permissionMode: shared.permissionMode,
  });

  try {
    const raw = readPreference(SETTINGS_STORAGE_KEY);
    if (!raw) return withShared(defaults);
    const stored = JSON.parse(raw) as Record<string, unknown>;
    const parsed = settingsSchema.partial().safeParse(stored);
    if (!parsed.success) return withShared(defaults);

    return withShared({
      ...defaults,
      ...parsed.data,
      voice: normalizeManagedVoice(stored.voice ?? legacyManagedVoice(stored.providers)),
    });
  } catch {
    return withShared(defaults);
  }
}

/**
 * Before realtime voice became managed-only, the voice lived per provider under
 * `providers.managed` (`providers.trial` earlier still). Bring-your-own-key
 * providers were removed, so whichever provider was active, only the managed
 * voice carries over; their keys and voice ids are ignored and dropped on save.
 */
function legacyManagedVoice(providers: unknown): unknown {
  if (!providers || typeof providers !== 'object') return undefined;
  const byId = providers as Record<string, { voice?: unknown } | undefined>;
  return (byId.managed ?? byId.trial)?.voice;
}

export function saveSettings(settings: VoiceSettings): void {
  if (typeof window === 'undefined') return;
  // Write the safety section back to the shared source of truth. A copy still
  // stays in this module's own blob (same shape, harmless), but reads always
  // take the shared value — when the two disagree the source of truth wins,
  // not whoever wrote last.
  saveDeviceSafetySections(settings);
  writePreference(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}
