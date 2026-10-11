import { describe, expect, it, vi } from 'vitest';
import { androidPushEnabled, setAndroidPushEnabled } from './android-push-preference';

describe('Android push consent', () => {
  it('starts disabled and separates accounts', () => {
    expect(androidPushEnabled('consent-a')).toBe(false);
    expect(setAndroidPushEnabled('consent-a', true)).toBe(true);
    expect(androidPushEnabled('consent-a')).toBe(true);
    expect(androidPushEnabled('consent-b')).toBe(false);
    expect(setAndroidPushEnabled('consent-a', false)).toBe(true);
    expect(androidPushEnabled('consent-a')).toBe(false);
  });

  it('does not retain a failed opt-in in the preference fallback', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('storage denied');
      },
    });
    try {
      expect(setAndroidPushEnabled('consent-storage-failure', true)).toBe(false);
      expect(androidPushEnabled('consent-storage-failure')).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
