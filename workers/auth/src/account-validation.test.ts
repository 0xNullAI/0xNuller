import { describe, expect, it } from 'vitest';
import { registrationConflict, validateCredentials } from './account-validation';

describe('registration validation', () => {
  it('accepts the boundary values and rejects invalid credentials', () => {
    expect(validateCredentials('abc', '12345678')).toBeNull();
    expect(validateCredentials('a'.repeat(24), '12345678')).toBeNull();
    expect(validateCredentials('ab', '12345678')).toContain('用户名');
    expect(validateCredentials('invalid name', '12345678')).toContain('用户名');
    expect(validateCredentials('alice', '1234567')).toBe('密码至少 8 位');
  });

  it('maps only known unique constraints to public conflict fields', () => {
    expect(registrationConflict(new Error('UNIQUE constraint failed: users.username'))).toBe(
      'username',
    );
    expect(
      registrationConflict(new Error('UNIQUE constraint failed: idx_users_email_unique')),
    ).toBe('email');
    expect(registrationConflict(new Error('UNIQUE constraint failed: unrelated.value'))).toBeNull();
    expect(registrationConflict(new Error('database unavailable'))).toBeNull();
  });
});
