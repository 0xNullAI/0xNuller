import { describe, expect, it } from 'vitest';
import type { Env } from './env.js';
import { isAllowedOrigin, parseVoiceTicket } from './trial-keys.js';

function env(overrides: Partial<Env> = {}): Env {
  return {
    TRIAL_SESSION: {} as DurableObjectNamespace,
    AUTH: {} as Env['AUTH'],
    XAI_API_KEY: 'xai-real-secret',
    TRIAL_MAX_SESSION_MINUTES: '20',
    ...overrides,
  };
}

describe('parseVoiceTicket', () => {
  it('extracts the account ticket from the WebSocket subprotocol token', () => {
    expect(parseVoiceTicket('realtime, openai-insecure-api-key.signed.account.ticket')).toBe(
      'signed.account.ticket',
    );
  });

  it('returns null when the header is missing or has no credential token', () => {
    expect(parseVoiceTicket(null)).toBeNull();
    expect(parseVoiceTicket('realtime')).toBeNull();
    expect(parseVoiceTicket('realtime, openai-insecure-api-key.')).toBeNull();
  });
});

describe('isAllowedOrigin', () => {
  it('allow-list 没配时也不放行任意来源——但本地开发照常', () => {
    // This used to assert `true`: an unset allow-list meant "allow everyone".
    // TRIAL_ALLOWED_ORIGINS is ordinary config, not a secret, so a deploy that
    // dropped it silently opened the trial quota — which spends real money —
    // to any origin. It now fails closed, while localhost still passes so
    // `wrangler dev` keeps working without editing the production list.
    const e = env({ TRIAL_ALLOWED_ORIGINS: undefined });
    expect(isAllowedOrigin('https://evil.example', e)).toBe(false);
    expect(isAllowedOrigin('http://localhost:5173', e)).toBe(true);
    expect(isAllowedOrigin('http://tauri.localhost', e)).toBe(true);
  });

  it('enforces membership when configured, but always allows localhost', () => {
    const e = env({ TRIAL_ALLOWED_ORIGINS: 'https://0xnullai.com' });
    expect(isAllowedOrigin('https://0xnullai.com', e)).toBe(true);
    expect(isAllowedOrigin('http://localhost:5173', e)).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:8787', e)).toBe(true);
    expect(isAllowedOrigin('https://evil.example', e)).toBe(false);
    expect(isAllowedOrigin(null, e)).toBe(false);
  });

  it('allows the Tauri WebView origin — otherwise trial voice 403s on Android', () => {
    const e = env({ TRIAL_ALLOWED_ORIGINS: 'https://0xnullai.com' });
    // There are no hot updates on Android: if this one breaks, the broken APK stays on users' phones for a long time.
    expect(isAllowedOrigin('http://tauri.localhost', e)).toBe(true);
    expect(isAllowedOrigin('https://tauri.localhost', e)).toBe(true);
    // But only this one hostname — not "allow anything ending in .localhost".
    expect(isAllowedOrigin('https://evil.localhost', e)).toBe(false);
  });
});
