import type { BrowserPermissionMode } from '@0xnullai/permissions';

/**
 * Device-safety settings shared by the whole app.
 *
 * Before the merge each of the three modules had its own set, differing in
 * both shape and naming:
 * - Agent: 23 flat fields in one `dg-agent.browser-settings` blob
 * - Voice: 13 fields nested under `coyoteSafety` / `opossumSafety`, 7 of
 *   them without any UI
 * - Chat: three bare localStorage string keys, and no policy engine at all
 *
 * The same concept had different names on each side
 * (`maxAdjustStrengthStep` vs `coyoteSafety.maxAdjustStep`,
 * `maxOpossumIntensityA` vs `opossumSafety.maxIntensityA`) while the
 * defaults matched — proof they were always the same thing, copied twice.
 *
 * Field names follow `@dg-kit/safety`'s `DefaultPolicyOptions`, because the
 * policy engine is where these numbers actually take effect; storage adapts
 * to the enforcer, not the other way around.
 *
 * Safety settings do NOT change when switching modules. That is the primary
 * reason this package exists: a user who caps at 30 in Agent must not see
 * 50 again after switching to Chat.
 */

export interface DeviceSafetySettings {
  // ── Coyote ──
  maxStrengthA: number;
  maxStrengthB: number;
  maxColdStartStrength: number;
  maxAdjustStep: number;
  maxBurstDurationMs: number;
  /** 0 disables this extra constraint. */
  maxBurstStrengthAbsolute: number;
  /** 0 disables this extra constraint. */
  maxBurstStrengthRelative: number;
  burstRequiresActiveChannel: boolean;

  // ── Opossum ──
  maxIntensityA: number;
  maxIntensityB: number;
  maxColdStartIntensity: number;
  maxOpossumAdjustStep: number;

  // ── Per-turn call caps (only meaningful when AI-driven, but they belong to device safety) ──
  maxToolIterations: number;
  maxToolCallsPerTurn: number;
  maxAdjustStrengthCallsPerTurn: number;
  maxBurstCallsPerTurn: number;
  maxVibrateAdjustCallsPerTurn: number;
  maxVibrateBurstCallsPerTurn: number;

  // ── Permission & lifecycle ──
  permissionMode: BrowserPermissionMode;
  /** Expiry timestamp for `timed` mode. */
  permissionModeExpiresAt?: number;
}

export const DEFAULT_DEVICE_SAFETY: DeviceSafetySettings = {
  maxStrengthA: 50,
  maxStrengthB: 50,
  maxColdStartStrength: 10,
  maxAdjustStep: 10,
  maxBurstDurationMs: 5_000,
  maxBurstStrengthAbsolute: 0,
  maxBurstStrengthRelative: 0,
  burstRequiresActiveChannel: true,

  maxIntensityA: 50,
  maxIntensityB: 50,
  maxColdStartIntensity: 10,
  maxOpossumAdjustStep: 10,

  maxToolIterations: 8,
  maxToolCallsPerTurn: 12,
  maxAdjustStrengthCallsPerTurn: 4,
  maxBurstCallsPerTurn: 2,
  maxVibrateAdjustCallsPerTurn: 4,
  maxVibrateBurstCallsPerTurn: 2,

  permissionMode: 'confirm',
};

const KEY = '0xnullai.device-safety';

/**
 * `allow-all` never survives a restart.
 *
 * Agent's semantics: full-allow lasts for the session and demotes to
 * `confirm` on persist. Voice used to persist it permanently — still
 * full-allow after a refresh. We adopt the strict one; otherwise the
 * "dangerous mode does not survive overnight" guarantee would silently
 * vanish in the merge.
 */
function persistableMode(mode: BrowserPermissionMode): BrowserPermissionMode {
  return mode === 'allow-all' ? 'confirm' : mode;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}

function coerce(raw: unknown): DeviceSafetySettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_DEVICE_SAFETY };
  const o = raw as Record<string, unknown>;
  const out = { ...DEFAULT_DEVICE_SAFETY };
  for (const key of Object.keys(DEFAULT_DEVICE_SAFETY) as (keyof DeviceSafetySettings)[]) {
    const fallback = DEFAULT_DEVICE_SAFETY[key];
    if (typeof fallback === 'number') {
      (out[key] as number) = num(o[key], fallback);
    } else if (typeof fallback === 'boolean') {
      (out[key] as boolean) = typeof o[key] === 'boolean' ? (o[key] as boolean) : fallback;
    }
  }
  const mode = o.permissionMode;
  out.permissionMode =
    mode === 'confirm' || mode === 'timed' || mode === 'allow-all'
      ? persistableMode(mode as BrowserPermissionMode)
      : 'confirm';
  if (typeof o.permissionModeExpiresAt === 'number') {
    out.permissionModeExpiresAt = o.permissionModeExpiresAt;
  }
  return out;
}

/**
 * Migration from the three pre-merge stores to the canonical field names.
 *
 * Two renames worth calling out: Agent's `maxAdjustStrengthStep` and
 * Voice's `coyoteSafety.maxAdjustStep` are the same thing; so are Agent's
 * `maxOpossumIntensityA` and Voice's `opossumSafety.maxIntensityA`. Missing
 * any mapping silently resets a user-tuned cap to its default — a failure
 * that is hard to notice precisely because the defaults are reasonable.
 */
function migrate(): DeviceSafetySettings | null {
  const out = { ...DEFAULT_DEVICE_SAFETY };
  let found = false;

  try {
    const agent = JSON.parse(localStorage.getItem('dg-agent.browser-settings') ?? 'null') as Record<
      string,
      unknown
    > | null;
    if (agent) {
      found = true;
      out.maxStrengthA = num(agent.maxStrengthA, out.maxStrengthA);
      out.maxStrengthB = num(agent.maxStrengthB, out.maxStrengthB);
      out.maxColdStartStrength = num(agent.maxColdStartStrength, out.maxColdStartStrength);
      out.maxAdjustStep = num(agent.maxAdjustStrengthStep, out.maxAdjustStep);
      out.maxBurstDurationMs = num(agent.maxBurstDurationMs, out.maxBurstDurationMs);
      out.maxBurstStrengthAbsolute = num(
        agent.maxBurstStrengthAbsolute,
        out.maxBurstStrengthAbsolute,
      );
      out.maxBurstStrengthRelative = num(
        agent.maxBurstStrengthRelative,
        out.maxBurstStrengthRelative,
      );
      if (typeof agent.burstRequiresActiveChannel === 'boolean') {
        out.burstRequiresActiveChannel = agent.burstRequiresActiveChannel;
      }
      out.maxIntensityA = num(agent.maxOpossumIntensityA, out.maxIntensityA);
      out.maxIntensityB = num(agent.maxOpossumIntensityB, out.maxIntensityB);
      out.maxColdStartIntensity = num(
        agent.maxOpossumColdStartIntensity,
        out.maxColdStartIntensity,
      );
      out.maxOpossumAdjustStep = num(agent.maxOpossumAdjustStep, out.maxOpossumAdjustStep);
      out.maxToolIterations = num(agent.maxToolIterations, out.maxToolIterations);
      out.maxToolCallsPerTurn = num(agent.maxToolCallsPerTurn, out.maxToolCallsPerTurn);
      out.maxAdjustStrengthCallsPerTurn = num(
        agent.maxAdjustStrengthCallsPerTurn,
        out.maxAdjustStrengthCallsPerTurn,
      );
      out.maxBurstCallsPerTurn = num(agent.maxBurstCallsPerTurn, out.maxBurstCallsPerTurn);
      out.maxVibrateAdjustCallsPerTurn = num(
        agent.maxVibrateAdjustCallsPerTurn,
        out.maxVibrateAdjustCallsPerTurn,
      );
      out.maxVibrateBurstCallsPerTurn = num(
        agent.maxVibrateBurstCallsPerTurn,
        out.maxVibrateBurstCallsPerTurn,
      );
      if (typeof agent.permissionMode === 'string') {
        out.permissionMode = persistableMode(agent.permissionMode as BrowserPermissionMode);
      }
    }
  } catch {
    // A corrupt Agent blob must not block the other sources.
  }

  try {
    const voice = JSON.parse(localStorage.getItem('dg-voice-settings') ?? 'null') as Record<
      string,
      unknown
    > | null;
    const coyote = voice?.coyoteSafety as Record<string, unknown> | undefined;
    const opossum = voice?.opossumSafety as Record<string, unknown> | undefined;
    if (coyote || opossum) {
      found = true;
      // Values Agent already wrote are not overwritten by Voice — when both
      // were tuned, first writer wins, so a user does not see "I changed
      // this module's setting but another module's stale value clobbered
      // it".
      if (coyote) {
        out.maxBurstDurationMs = num(coyote.maxBurstDurationMs, out.maxBurstDurationMs);
        out.maxBurstStrengthAbsolute = num(
          coyote.maxBurstStrengthAbsolute,
          out.maxBurstStrengthAbsolute,
        );
        out.maxBurstStrengthRelative = num(
          coyote.maxBurstStrengthRelative,
          out.maxBurstStrengthRelative,
        );
      }
      if (opossum) {
        out.maxColdStartIntensity = num(opossum.maxColdStartIntensity, out.maxColdStartIntensity);
        out.maxOpossumAdjustStep = num(opossum.maxAdjustStep, out.maxOpossumAdjustStep);
      }
    }
  } catch {
    // Same as above.
  }

  try {
    const bg = localStorage.getItem('dg-bg-behavior');
    if (bg === 'keep' || bg === 'stop') {
      found = true;
    }
  } catch {
    // Same as above.
  }

  return found ? out : null;
}

const listeners = new Set<(s: DeviceSafetySettings) => void>();

export function loadDeviceSafety(): DeviceSafetySettings {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_DEVICE_SAFETY };
  try {
    const own = localStorage.getItem(KEY);
    if (own) return coerce(JSON.parse(own));
    const migrated = migrate();
    if (migrated) {
      saveDeviceSafety(migrated);
      return migrated;
    }
  } catch {
    // On corrupt storage fall back to defaults — they are the most
    // conservative set, so failing in this direction is safe.
  }
  return { ...DEFAULT_DEVICE_SAFETY };
}

export function saveDeviceSafety(next: DeviceSafetySettings): DeviceSafetySettings {
  const persisted: DeviceSafetySettings = {
    ...next,
    permissionMode: persistableMode(next.permissionMode),
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(persisted));
  } catch {
    // If the write fails the values still apply for this session.
  }
  for (const l of listeners) l(next);
  return next;
}

export function updateDeviceSafety(
  updater: (prev: DeviceSafetySettings) => DeviceSafetySettings,
): DeviceSafetySettings {
  return saveDeviceSafety(updater(loadDeviceSafety()));
}

export function subscribeDeviceSafety(listener: (s: DeviceSafetySettings) => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) listener(loadDeviceSafety());
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/**
 * The permission mode currently *in effect*.
 *
 * `timed` falls back to `confirm` after expiry. The check must happen on
 * read, not only on write — the user may keep the page open past the five
 * minutes.
 */
export function effectivePermissionMode(s: DeviceSafetySettings): BrowserPermissionMode {
  if (s.permissionMode !== 'timed') return s.permissionMode;
  if (!s.permissionModeExpiresAt || Date.now() > s.permissionModeExpiresAt) return 'confirm';
  return 'timed';
}
