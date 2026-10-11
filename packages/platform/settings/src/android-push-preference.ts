import { readPreference, writePreference } from './preference-storage.js';

const key = (accountId: string) => `android-push-enabled:${accountId}`;
const revokeKey = (accountId: string) => `android-push-pending-revoke:${accountId}`;

/** Android notification consent is per installation and per signed-in account. */
export function androidPushEnabled(accountId: string | null): boolean {
  return Boolean(accountId && readPreference(key(accountId)) === 'true');
}

export function setAndroidPushEnabled(accountId: string, enabled: boolean): boolean {
  const saved = writePreference(key(accountId), enabled ? 'true' : 'false');
  // A failed opt-in must not survive in the preference layer's memory fallback:
  // focus reconciliation must never register after telling the user it failed.
  if (!saved && enabled) writePreference(key(accountId), 'false');
  return saved;
}

/** Keep a failed DELETE retryable after the native bridge clears its local FID. */
export function pendingAndroidPushRevocation(accountId: string): string | null {
  const value = readPreference(revokeKey(accountId));
  return value && /^[A-Za-z0-9_-]{16,256}$/.test(value) ? value : null;
}

export function setPendingAndroidPushRevocation(
  accountId: string,
  installationId: string | null,
): void {
  writePreference(revokeKey(accountId), installationId ?? '');
}
