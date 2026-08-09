/**
 * Local record of the groups this browser belongs to, and of the owner keys it holds.
 *
 * Two things have to live client-side now that a room is a permanent group:
 *
 * 1. The owner key. Creating a group must not require an account (CLAUDE.md), so ownership
 *    cannot hang off a user id — it is a secret the creator keeps, exactly the way Market's
 *    edit key works. The server stores only its hash; lose this and the group has no owner.
 * 2. The list of groups you are in. A private group is not in the lobby and an empty public
 *    one has nobody to announce it, so without a local list a group you created would be
 *    unreachable the moment you closed the tab — the room code was the only way back.
 *
 * Storage keys follow the existing convention (`dg-chat-name`, `dg-chat-allow-ai`), and the
 * per-group key mirrors Market's `dg-market-edit-key:<id>`.
 */

const OWNER_KEY_PREFIX = 'dg-chat-owner-key';
const GROUPS_KEY = 'dg-chat-groups';

/** A group this browser has been in, as the sidebar needs it. */
export interface KnownGroup {
  code: string;
  name: string;
}

export function loadOwnerKey(code: string): string | null {
  if (!code) return null;
  try {
    return localStorage.getItem(`${OWNER_KEY_PREFIX}:${code}`);
  } catch {
    return null;
  }
}

export function saveOwnerKey(code: string, key: string): void {
  if (!code || !key) return;
  try {
    localStorage.setItem(`${OWNER_KEY_PREFIX}:${code}`, key);
  } catch {
    /* storage full or blocked; ownership is then only as durable as this tab */
  }
}

export function loadKnownGroups(): KnownGroup[] {
  try {
    const raw = localStorage.getItem(GROUPS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((g): g is KnownGroup => !!g && typeof (g as KnownGroup).code === 'string')
      .map(g => ({ code: g.code, name: typeof g.name === 'string' ? g.name : '' }));
  } catch {
    return [];
  }
}

/**
 * Record a group locally, or refresh its name.
 *
 * Called on join rather than on create: being in a group is what makes it worth listing,
 * and a group someone invited you to by code is just as unreachable afterwards as one you
 * made yourself.
 */
export function rememberGroup(code: string, name?: string): void {
  if (!code) return;
  const groups = loadKnownGroups();
  const existing = groups.find(g => g.code === code);
  if (existing) {
    // An empty name means "not known yet", never "clear the name I already had".
    if (!name || existing.name === name) return;
    existing.name = name;
  } else {
    groups.push({ code, name: name ?? '' });
  }
  save(groups);
}

export function forgetGroup(code: string): void {
  save(loadKnownGroups().filter(g => g.code !== code));
}

function save(groups: KnownGroup[]): void {
  try {
    localStorage.setItem(GROUPS_KEY, JSON.stringify(groups));
  } catch {
    /* storage full or blocked; the list is a convenience, not a source of truth */
  }
}
