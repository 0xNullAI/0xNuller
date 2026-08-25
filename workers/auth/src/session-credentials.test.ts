import { describe, expect, it } from 'vitest';
import { readToken, sessionCookie } from './session-credentials';

describe('session credential carriers', () => {
  it('prefers a bearer credential and trims it', () => {
    const request = new Request('https://auth.0xnullai.com/api/auth/me', {
      headers: {
        Authorization: 'Bearer android-token  ',
        Cookie: '0xn_session=web-token',
      },
    });
    expect(readToken(request)).toBe('android-token');
  });

  it('reads the shared web cookie and rejects empty credentials', () => {
    expect(
      readToken(
        new Request('https://auth.0xnullai.com/api/auth/me', {
          headers: { Cookie: 'theme=dark; 0xn_session=web-token; locale=zh' },
        }),
      ),
    ).toBe('web-token');
    expect(
      readToken(
        new Request('https://auth.0xnullai.com/api/auth/me', {
          headers: { Authorization: 'Bearer   ' },
        }),
      ),
    ).toBeNull();
  });

  it('keeps the cross-subdomain secure cookie contract', () => {
    expect(sessionCookie('session-token', 3600)).toBe(
      '0xn_session=session-token; Path=/; Domain=.0xnullai.com; HttpOnly; Secure; SameSite=Lax; Max-Age=3600',
    );
    expect(sessionCookie('', 0)).toContain('0xn_session=;');
  });
});
