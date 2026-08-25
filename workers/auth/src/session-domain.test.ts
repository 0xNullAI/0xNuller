import { describe, expect, it } from 'vitest';
import { newToken, publicUser, sessionUser, sha256Hex, type UserRow } from './session-domain';

const user: UserRow = {
  id: 'user-1',
  username: 'alice',
  display_name: 'Alice',
  password_hash: 'private',
  created_at: 1,
  banned_at: null,
  ban_reason: null,
  role: 'admin',
  email: 'alice@example.com',
  email_verified_at: 2,
};

describe('session domain', () => {
  it('keeps role and email out of public profile summaries', () => {
    expect(publicUser(user)).toEqual({ id: 'user-1', username: 'alice', displayName: 'Alice' });
  });

  it('adds session-only account fields for the authenticated client', () => {
    expect(sessionUser(user, true)).toEqual({
      id: 'user-1',
      username: 'alice',
      displayName: 'Alice',
      role: 'admin',
      email: 'alice@example.com',
      emailVerified: true,
      emailAvailable: true,
    });
  });

  it('creates opaque 256-bit hexadecimal session tokens', () => {
    const first = newToken();
    const second = newToken();
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toMatch(/^[a-f0-9]{64}$/);
    expect(second).not.toBe(first);
  });

  it('hashes session credentials with SHA-256', async () => {
    expect(await sha256Hex('session-token')).toBe(
      'c101e911469c969171040b50d70543313cf968fdef5bacc780776f8fb399ab36',
    );
  });
});
