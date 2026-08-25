const MIN_PASSWORD_LENGTH = 8;

export function validateCredentials(username: unknown, password: unknown): string | null {
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_-]{3,24}$/.test(username)) {
    return '用户名需为 3–24 位字母、数字、下划线或连字符';
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `密码至少 ${MIN_PASSWORD_LENGTH} 位`;
  }
  return null;
}

export function registrationConflict(error: unknown): 'username' | 'email' | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!/unique constraint/i.test(message)) return null;
  if (/users\.username|username/i.test(message)) return 'username';
  if (/idx_users_email_unique|users\.email|email/i.test(message)) return 'email';
  return null;
}
