import { readPreference, writePreference } from './preference-storage.js';

const key = (accountId: string) => `web-notifications-enabled:${accountId}`;

/** Browser system notifications for new messages: opt-in, per browser and per account. */
export function webNotificationsEnabled(accountId: string | null): boolean {
  return Boolean(accountId && readPreference(key(accountId)) === 'true');
}

export function setWebNotificationsEnabled(accountId: string, enabled: boolean): boolean {
  return writePreference(key(accountId), enabled ? 'true' : 'false');
}
