// Deterministic, self-rotating 体验版 activation key.
//
// The key for a given day is `HMAC-SHA256(TRIAL_DAILY_SEED, <AOE date>)` — so
// it is *derivable*, not stored. Validation recomputes today's (and, within a
// grace window, yesterday's) key and compares; the daily cron only needs to
// EMAIL the key, it is not what makes the key valid. If the cron or email ever
// fails, the key still works because the Worker derives it on demand.
//
// "Daily" is measured in AOE (Anywhere-on-Earth, UTC-12): a new AOE day begins
// at 12:00 UTC, so the key rotates then. This is the latest-timezone convention
// used for deadlines — a key labelled for AOE date D is the one everyone on
// Earth can still call "today's" until D has ended everywhere.
import type { Env, TrialKeyConfig } from './env.js';

const AOE_OFFSET_MS = 12 * 60 * 60 * 1000; // AOE = UTC-12
const HMAC_DOMAIN = 'dg-voice-trial'; // domain-separates this HMAC use from any other
const HASH_LEN = 32; // base64url chars kept from the digest

/** The calendar date (YYYY-MM-DD) it currently is in the last time zone on Earth. */
export function aoeDate(now: number): string {
  return new Date(now - AOE_OFFSET_MS).toISOString().slice(0, 10);
}

/** Derives the activation key for a specific AOE date. Deterministic given the seed. */
export async function deriveDailyKey(seed: string, date: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(seed),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(`${HMAC_DOMAIN}|${date}`));
  const hash = base64url(new Uint8Array(sig)).slice(0, HASH_LEN);
  return `dgv-daily-${date.replaceAll('-', '')}-${hash}`;
}

/** Today's key (for the notifier). `null` when no seed is configured. */
export async function currentDailyKey(env: Env, now: number): Promise<string | null> {
  const seed = env.TRIAL_DAILY_SEED?.trim();
  if (!seed) return null;
  return deriveDailyKey(seed, aoeDate(now));
}

/**
 * Validates a submitted key against the derived daily key(s), returning caps or
 * `null`. Accepts today's key always, and yesterday's for `TRIAL_DAILY_GRACE_MINUTES`
 * after the rollover so a call in progress at 12:00 UTC — or someone handed the
 * key shortly before — isn't cut off mid-use.
 */
export async function resolveDailyKey(
  env: Env,
  key: string,
  now: number,
): Promise<TrialKeyConfig | null> {
  if (!env.XAI_API_KEY) return null; // no upstream credential → nothing to lend
  const seed = env.TRIAL_DAILY_SEED?.trim();
  if (!seed) return null;

  const today = aoeDate(now);
  const candidates = [await deriveDailyKey(seed, today)];

  const graceMinutes = positiveInt(env.TRIAL_DAILY_GRACE_MINUTES, 180);
  const aoeDayStartUtc = Date.parse(`${today}T00:00:00Z`) + AOE_OFFSET_MS; // 12:00 UTC of `today`
  if (now - aoeDayStartUtc < graceMinutes * 60_000) {
    candidates.push(await deriveDailyKey(seed, aoeDate(now - 86_400_000)));
  }

  if (!candidates.some((candidate) => timingSafeEqual(candidate, key))) return null;

  return {
    maxSessionMinutes: positiveInt(env.TRIAL_MAX_SESSION_MINUTES, 20),
    dailyCapMinutes: positiveInt(env.TRIAL_DAILY_CAP_MINUTES ?? env.TRIAL_DEFAULT_DAILY_CAP_MINUTES, 60),
  };
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** Length-then-constant-time string compare, so a valid key can't be timed out char by char. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
