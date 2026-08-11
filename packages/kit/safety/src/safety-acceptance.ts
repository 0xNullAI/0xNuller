/**
 * Acceptance state of the safety notice.
 *
 * One copy for the whole system. Before the merge, Agent and Chat each gated
 * their own entry point and tracked their own state, so inside the unified
 * shell the same notice had to be accepted twice. The notice itself now
 * exists once (see `safety-notice-content.ts`), so its acceptance state must
 * too — confirmed once on entering the app, counted for all modules.
 *
 * The gate itself is not weakened: the default is "show", and only an
 * explicit "do not show again" checkbox is remembered. Without the checkbox
 * the acceptance lasts for the session and the notice shows again next
 * launch.
 */

const KEY = '0xnullai.safety-accepted';
/** Per-module keys from before the merge, migrated once on read. */
const LEGACY_KEYS = ['dg-chat-safety-accepted'];

/**
 * Whether the user has permanently accepted.
 *
 * Returns false when storage is unreadable — it MUST be false. In private
 * browsing or on a storage error, showing the notice one extra time is fine;
 * silently waving the user through because a read failed is not.
 */
export function isSafetyNoticeAccepted(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    if (localStorage.getItem(KEY) === 'true') return true;
    for (const legacy of LEGACY_KEYS) {
      if (localStorage.getItem(legacy) === 'true') {
        localStorage.setItem(KEY, 'true');
        return true;
      }
    }
  } catch {
    // Unreadable storage counts as not accepted.
  }
  return false;
}

/** Persist "do not show again". Call only on an explicit user checkbox. */
export function rememberSafetyNoticeAccepted(): void {
  try {
    localStorage.setItem(KEY, 'true');
  } catch {
    // If the write fails, the notice shows again next time — failing in
    // this direction is safe.
  }
}

/** Re-arm the notice (the "show safety notice again" setting). */
export function forgetSafetyNoticeAccepted(): void {
  try {
    localStorage.removeItem(KEY);
    for (const legacy of LEGACY_KEYS) localStorage.removeItem(legacy);
  } catch {
    // Ignore: if this fails the user can still clear site data.
  }
}
