import { describe, expect, it } from 'vitest';
import type { Env } from './env.js';
import { isAllowedOrigin, parseActivationKey, resolveTrialKey } from './trial-keys.js';

function env(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: {} as Fetcher,
    TRIAL_SESSION: {} as DurableObjectNamespace,
    EMAIL: {} as Env['EMAIL'],
    XAI_API_KEY: 'xai-real-secret',
    TRIAL_KEYS: JSON.stringify({
      'dgv-trial-ok': { dailyCapMinutes: 30 },
      'dgv-trial-off': { enabled: false },
      'dgv-trial-expired': { expiresAt: 1000 },
    }),
    TRIAL_MAX_SESSION_MINUTES: '20',
    TRIAL_DEFAULT_DAILY_CAP_MINUTES: '60',
    ...overrides,
  };
}

describe('parseActivationKey', () => {
  it('extracts the key from the openai-insecure-api-key subprotocol token', () => {
    expect(parseActivationKey('realtime, openai-insecure-api-key.dgv-trial-ok')).toBe('dgv-trial-ok');
  });

  it('returns null when the header is missing or has no credential token', () => {
    expect(parseActivationKey(null)).toBeNull();
    expect(parseActivationKey('realtime')).toBeNull();
    expect(parseActivationKey('realtime, openai-insecure-api-key.')).toBeNull();
  });
});

describe('resolveTrialKey', () => {
  it('resolves a valid key to its caps (per-key daily cap wins over the default)', () => {
    const config = resolveTrialKey(env(), 'dgv-trial-ok', 5000);
    expect(config).toEqual({ maxSessionMinutes: 20, dailyCapMinutes: 30 });
  });

  it('falls back to the default daily cap when the entry omits one', () => {
    const e = env({ TRIAL_KEYS: JSON.stringify({ 'dgv-trial-plain': {} }) });
    expect(resolveTrialKey(e, 'dgv-trial-plain', 5000)?.dailyCapMinutes).toBe(60);
  });

  it('rejects unknown, disabled, and expired keys', () => {
    expect(resolveTrialKey(env(), 'dgv-trial-nope', 5000)).toBeNull();
    expect(resolveTrialKey(env(), 'dgv-trial-off', 5000)).toBeNull();
    expect(resolveTrialKey(env(), 'dgv-trial-expired', 5000)).toBeNull();
  });

  it('rejects everything when no upstream key or registry is configured', () => {
    expect(resolveTrialKey(env({ XAI_API_KEY: undefined }), 'dgv-trial-ok', 5000)).toBeNull();
    expect(resolveTrialKey(env({ TRIAL_KEYS: undefined }), 'dgv-trial-ok', 5000)).toBeNull();
    expect(resolveTrialKey(env({ TRIAL_KEYS: 'not json' }), 'dgv-trial-ok', 5000)).toBeNull();
  });
});

describe('isAllowedOrigin', () => {
  it('is permissive when the allow-list is unset', () => {
    expect(isAllowedOrigin('https://evil.example', env({ TRIAL_ALLOWED_ORIGINS: undefined }))).toBe(true);
  });

  it('enforces membership when configured, but always allows localhost', () => {
    const e = env({ TRIAL_ALLOWED_ORIGINS: 'https://voice.0xnullai.com' });
    expect(isAllowedOrigin('https://voice.0xnullai.com', e)).toBe(true);
    expect(isAllowedOrigin('http://localhost:5173', e)).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:8787', e)).toBe(true);
    expect(isAllowedOrigin('https://evil.example', e)).toBe(false);
    expect(isAllowedOrigin(null, e)).toBe(false);
  });
});
