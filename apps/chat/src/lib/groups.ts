/**
 * Offline cache of the groups this account/browser belongs to, and device-local owner keys.
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

import { closeChatRoom, forgetChatRoom, pullChatRooms, rememberChatRoom } from '@0xnullai/sync';

const OWNER_KEY_PREFIX = 'dg-chat-owner-key';
const GROUPS_KEY = 'dg-chat-groups';
const GROUPS_MIGRATED_KEY = 'dg-chat-groups-account-migrated-v1';
export const GROUPS_CHANGED_EVENT = '0xnullai:chat-groups-changed';

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
    const group = loadKnownGroups().find((item) => item.code === code);
    void rememberChatRoom(code, group?.name ?? '', key);
  } catch {
    /* storage full or blocked; ownership is then only as durable as this tab */
  }
}

export async function closeOwnedGroup(code: string): Promise<boolean> {
  const key = loadOwnerKey(code);
  return key ? closeChatRoom(code, key) : false;
}

export function loadKnownGroups(): KnownGroup[] {
  try {
    const raw = localStorage.getItem(GROUPS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((g): g is KnownGroup => !!g && typeof (g as KnownGroup).code === 'string')
      .map((g) => ({ code: g.code, name: typeof g.name === 'string' ? g.name : '' }));
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
  const existing = groups.find((g) => g.code === code);
  if (existing) {
    // An empty name means "not known yet", never "clear the name I already had".
    if (!name || existing.name === name) return;
    existing.name = name;
  } else {
    groups.push({ code, name: name ?? '' });
  }
  save(groups);
  void rememberChatRoom(code, name ?? '');
}

export function forgetGroup(code: string): void {
  if (!code) return;
  save(loadKnownGroups().filter((group) => group.code !== code));
  void forgetChatRoom(code);
  try {
    localStorage.removeItem(`${OWNER_KEY_PREFIX}:${code}`);
  } catch {
    /* storage unavailable */
  }
}

function save(groups: KnownGroup[]): void {
  try {
    localStorage.setItem(GROUPS_KEY, JSON.stringify(groups));
    window.dispatchEvent(new Event(GROUPS_CHANGED_EVENT));
  } catch {
    /* storage full or blocked; the list is a convenience, not a source of truth */
  }
}

/**
 * Refresh the offline cache from the account. On the first signed-in load, legacy local rooms
 * are uploaded before the authoritative list is pulled so an upgrade cannot lose private rooms.
 * A null response means signed out/offline and leaves the cache untouched.
 */
export async function syncKnownGroups(): Promise<KnownGroup[] | null> {
  const local = loadKnownGroups();
  const remote = await pullChatRooms();
  if (remote === null) return null;

  const remoteCodes = new Set(remote.map((room) => room.code));
  const migrated = (() => {
    try {
      return localStorage.getItem(GROUPS_MIGRATED_KEY) === '1';
    } catch {
      // Treat blocked storage as already migrated: repeatedly resurrecting a deleted room is worse
      // than requiring that one browser to join an old room by code again.
      return true;
    }
  })();
  const legacy = migrated ? [] : local.filter((room) => !remoteCodes.has(room.code));
  if (legacy.length > 0) {
    await Promise.all(legacy.map((room) => rememberChatRoom(room.code, room.name)));
  }
  const refreshed = legacy.length > 0 ? await pullChatRooms() : remote;
  if (refreshed === null) return null;
  try {
    localStorage.setItem(GROUPS_MIGRATED_KEY, '1');
  } catch {
    /* cache unavailable */
  }
  const groups = refreshed.map(({ code, name }) => ({ code, name }));
  for (const room of refreshed) if (room.ownerKey) saveOwnerKey(room.code, room.ownerKey);
  save(groups);
  return groups;
}
