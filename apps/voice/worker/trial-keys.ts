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
  const allow = env.TRIAL_ALLOWED_ORIGINS?.trim();
  if (!allow) return true; // unset ⇒ permissive (dev / preview)
  if (!origin) return false;
  try {
    const host = new URL(origin).hostname;
    // localhost：让 `wrangler dev` 不必改生产白名单。
    if (host === 'localhost' || host === '127.0.0.1') return true;
    // tauri.localhost：安卓壳的 WebView origin。不放行的话体验版语音在手机上一律
    // 403，而界面只会显示「连接失败」。
    //
    // 这不削弱防护：Origin 头只对浏览器有约束力，原生程序想伪造随时可以。真正的
    // 闸门是激活密钥与 TrialSession 的用量上限，白名单只是挡住「别的网页直接嵌一个
    // WebSocket 蹭额度」这一种情形。
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
