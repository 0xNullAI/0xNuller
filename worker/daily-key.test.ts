import { describe, expect, it } from 'vitest';
import type { Env } from './env.js';
import { aoeDate, deriveDailyKey, resolveDailyKey } from './daily-key.js';

const SEED = 'test-seed-do-not-use-in-prod';

function env(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: {} as Fetcher,
    TRIAL_SESSION: {} as DurableObjectNamespace,
    EMAIL: {} as Env['EMAIL'],
    XAI_API_KEY: 'xai-real-secret',
    TRIAL_DAILY_SEED: SEED,
    TRIAL_MAX_SESSION_MINUTES: '20',
    TRIAL_DEFAULT_DAILY_CAP_MINUTES: '60',
    ...overrides,
  };
}

// A moment well inside an AOE day (18:00 UTC = 06:00 AOE), away from the 12:00
// UTC rollover so grace-window edges don't interfere.
const MIDDAY = Date.parse('2026-07-24T18:00:00Z');

describe('aoeDate', () => {
  it('rolls the AOE day over at 12:00 UTC (UTC-12)', () => {
    expect(aoeDate(Date.parse('2026-07-24T12:00:00Z'))).toBe('2026-07-24');
    expect(aoeDate(Date.parse('2026-07-24T11:59:59Z'))).toBe('2026-07-23');
  });
});

describe('deriveDailyKey', () => {
  it('is deterministic and shaped dgv-daily-<compactdate>-<hash>', async () => {
    const a = await deriveDailyKey(SEED, '2026-07-24');
    const b = await deriveDailyKey(SEED, '2026-07-24');
    expect(a).toBe(b);
    expect(a).toMatch(/^dgv-daily-20260724-[A-Za-z0-9_-]{32}$/);
  });

  it('differs by date and by seed', async () => {
    expect(await deriveDailyKey(SEED, '2026-07-24')).not.toBe(await deriveDailyKey(SEED, '2026-07-25'));
    expect(await deriveDailyKey(SEED, '2026-07-24')).not.toBe(await deriveDailyKey('other', '2026-07-24'));
  });
});

describe('resolveDailyKey', () => {
  it("accepts today's derived key and returns caps", async () => {
    const key = await deriveDailyKey(SEED, aoeDate(MIDDAY));
    expect(await resolveDailyKey(env(), key, MIDDAY)).toEqual({ maxSessionMinutes: 20, dailyCapMinutes: 60 });
  });

  it('honours TRIAL_DAILY_CAP_MINUTES over the default', async () => {
    const key = await deriveDailyKey(SEED, aoeDate(MIDDAY));
    expect((await resolveDailyKey(env({ TRIAL_DAILY_CAP_MINUTES: '30' }), key, MIDDAY))?.dailyCapMinutes).toBe(30);
  });

  it('rejects an unknown key and a key derived from a different seed', async () => {
    expect(await resolveDailyKey(env(), 'dgv-daily-20260724-nope', MIDDAY)).toBeNull();
    const wrong = await deriveDailyKey('other-seed', aoeDate(MIDDAY));
    expect(await resolveDailyKey(env(), wrong, MIDDAY)).toBeNull();
  });

  it('rejects when no seed or no upstream key is configured', async () => {
    const key = await deriveDailyKey(SEED, aoeDate(MIDDAY));
    expect(await resolveDailyKey(env({ TRIAL_DAILY_SEED: undefined }), key, MIDDAY)).toBeNull();
    expect(await resolveDailyKey(env({ XAI_API_KEY: undefined }), key, MIDDAY)).toBeNull();
  });

  it("accepts yesterday's key within the grace window and rejects it after", async () => {
    // 13:00 UTC 07-24 = 1h into AOE day 07-24; yesterday = 07-23.
    const justAfterRollover = Date.parse('2026-07-24T13:00:00Z');
    const ykey = await deriveDailyKey(SEED, '2026-07-23');
    // Within a 180-min grace: accepted.
    expect(await resolveDailyKey(env(), ykey, justAfterRollover)).not.toBeNull();
    // With a 30-min grace, 1h in is past it: rejected.
    expect(await resolveDailyKey(env({ TRIAL_DAILY_GRACE_MINUTES: '30' }), ykey, justAfterRollover)).toBeNull();
    // Deep inside the day, yesterday's key is always gone.
    expect(await resolveDailyKey(env(), ykey, MIDDAY)).toBeNull();
  });
});
