import { afterEach, expect, it, vi } from 'vitest';
import { readPreference, writePreference, persistenceWarning } from './preference-storage';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('keeps ordinary preferences in memory and reports a failed save', () => {
  vi.stubGlobal('localStorage', {
    setItem: () => {
      throw new DOMException('quota', 'QuotaExceededError');
    },
  });
  expect(writePreference('audit-test-pref', 'value')).toBe(false);
  expect(readPreference('audit-test-pref')).toBe('value');
  expect(persistenceWarning()).toContain('无法保存');
});
it('recovers from storage permission errors on read', () => {
  vi.stubGlobal('localStorage', {
    getItem: () => {
      throw new DOMException('denied', 'SecurityError');
    },
  });
  expect(readPreference('audit-test-unreadable')).toBeNull();
});
