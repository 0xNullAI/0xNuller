import type { Env, TrialKeyConfig } from './env.js';

interface TrialKeyEntry {
  enabled?: boolean;
  expiresAt?: number;
  dailyCapMinutes?: number;
}

/**
 * Pulls the activation key out of the offered WebSocket subprotocols. The
 * browser connects with `['realtime', 'openai-insecure-api-key.<key>']`
 * (the same shape as a direct xAI connection), which arrives here as the
 * `Sec-WebSocket-Protocol` request header.
 */
export function parseActivationKey(header: string | null): string | null {
  if (!header) return null;
  const prefix = 'openai-insecure-api-key.';
  for (const raw of header.split(',')) {
    const token = raw.trim();
    if (token.startsWith(prefix)) {
      const key = token.slice(prefix.length).trim();
      return key.length > 0 ? key : null;
    }
  }
  return null;
}

/**
 * Validates an activation key against the `TRIAL_KEYS` registry and returns
 * its resolved caps, or `null` if the key is unknown / disabled / expired.
 */
export function resolveTrialKey(env: Env, key: string, now: number): TrialKeyConfig | null {
  if (!env.XAI_API_KEY) return null; // no upstream credential configured → nothing to lend
  if (!env.TRIAL_KEYS) return null;

  let registry: Record<string, TrialKeyEntry>;
  try {
    registry = JSON.parse(env.TRIAL_KEYS) as Record<string, TrialKeyEntry>;
  } catch {
    return null;
  }

  const entry = registry[key];
  if (!entry || entry.enabled === false) return null;
  if (typeof entry.expiresAt === 'number' && now > entry.expiresAt) return null;

  const maxSessionMinutes = positiveInt(env.TRIAL_MAX_SESSION_MINUTES, 20);
  const defaultDailyCap = positiveInt(env.TRIAL_DEFAULT_DAILY_CAP_MINUTES, 60);
  const dailyCapMinutes =
    typeof entry.dailyCapMinutes === 'number' && entry.dailyCapMinutes > 0
      ? entry.dailyCapMinutes
      : defaultDailyCap;

  return { maxSessionMinutes, dailyCapMinutes };
}

export function isAllowedOrigin(origin: string | null, env: Env): boolean {
  // An unset allow-list used to mean "allow everyone". It is ordinary config,
  // not a secret, so a deploy that loses it silently opened the trial quota —
  // which spends real money — to any origin. Unset now falls through to the
  // localhost checks below, so `wrangler dev` still works and nothing else does.
  const allow = env.TRIAL_ALLOWED_ORIGINS?.trim() ?? '';
  if (!origin) return false;
  try {
    const host = new URL(origin).hostname;
    // localhost: lets `wrangler dev` work without editing the production allow-list.
    if (host === 'localhost' || host === '127.0.0.1') return true;
    // tauri.localhost: the Android shell's WebView origin. Without allowing it,
    // trial voice 403s on phones every single time and the UI only shows
    // 「连接失败」.
    //
    // This doesn't weaken the protection: the Origin header only binds
    // browsers, and a native program can forge it whenever it likes. The real
    // gate is the activation key plus TrialSession's usage caps; the allow-list
    // only blocks the one case of another web page embedding a WebSocket
    // directly and riding on the quota.
    if (host === 'tauri.localhost') return true;
  } catch {
    return false;
  }
  return allow
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
    .includes(origin);
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
