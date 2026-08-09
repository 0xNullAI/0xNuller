/**
 * "Open this person's profile" as a shell-wide request.
 *
 * A profile is a shell surface, not a module one: it is reachable from Chat's
 * member list, from the contacts dialog and from the account dialog, and there
 * must be exactly one of it. Modules therefore ask rather than render — the
 * same shape as the existing module/shell seams, where a module contributes an
 * intent and the shell owns the surface.
 *
 * A publish/subscribe cell rather than React context because the callers are
 * across a module boundary: Chat is lazily mounted inside the shell and would
 * otherwise need a provider threaded into it, which is exactly the kind of
 * coupling the four-interface shell contract exists to avoid.
 *
 * Requests carry a **username**, not an account id. Username is the only handle
 * the account service accepts for a lookup, and it is the only one a person can
 * read back off the screen and verify they opened the right profile.
 */

type Listener = (username: string) => void;

const listeners = new Set<Listener>();

/**
 * Ask for a profile to be opened. Safe to call from anywhere, including when
 * nothing is listening.
 *
 * Requests are **not** queued for a later subscriber. The shell subscribes on
 * mount, before any module it hosts can render, so a dropped request only
 * happens where there is no shell at all — a module built standalone — and
 * there doing nothing is the right answer. Holding the request instead would
 * mean a profile springing open later, long after the click that asked for it.
 */
export function requestProfileView(username: string): void {
  const name = username.trim();
  if (!name) return;
  for (const listener of listeners) listener(name);
}

/** The shell subscribes once. Returns the unsubscribe. */
export function subscribeProfileRequests(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
