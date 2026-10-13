import { currentAuthUserId, subscribeAuthChanges } from './index';
import { getCharacterAppearance, type CharacterAppearance } from './character-appearance';

/**
 * Page-memory sharing for character avatars. Every assistant row mounts its own avatar, so
 * without this each one fetched the same appearance and the same private photo bytes.
 *
 * Entries are bound to the account that read them and are dropped (photo URLs revoked, reads
 * aborted) the moment the account changes, so private bytes never outlive their account.
 */

// An unused photo stays briefly so switching conversations or re-rendering a list does not
// download it again; then its bytes are released.
const PHOTO_IDLE_MS = 60_000;

interface PhotoEntry {
  account: string;
  url: Promise<string | null>;
  objectUrl: string | null;
  controller: AbortController;
  refs: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const photos = new Map<string, PhotoEntry>();
const appearances = new Map<string, Promise<CharacterAppearance>>();
let listening = false;

function listenOnce(): void {
  if (listening) return;
  listening = true;
  subscribeAuthChanges(() => {
    const account = currentAuthUserId();
    for (const [key, entry] of photos) if (entry.account !== account) evictPhoto(key, entry);
    for (const key of appearances.keys())
      if (!key.startsWith(`${account ?? ''}\0`)) appearances.delete(key);
  });
  if (typeof window !== 'undefined')
    window.addEventListener('0xnullai:appearance-changed', () => appearances.clear());
}

function evictPhoto(key: string, entry: PhotoEntry): void {
  if (photos.get(key) !== entry) return;
  photos.delete(key);
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.controller.abort();
  if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
}

/**
 * Share one read and one object URL per (account, photo). Call `release` when the holder
 * unmounts; the bytes go once nothing has held them for a while.
 */
export function acquireCharacterPhoto(
  account: string,
  photoId: string,
  load: (signal: AbortSignal) => Promise<Blob | null>,
): { url: Promise<string | null>; release: () => void } {
  listenOnce();
  const key = `${account}\0${photoId}`;
  let entry = photos.get(key);
  if (!entry) {
    const controller = new AbortController();
    const created: PhotoEntry = {
      account,
      url: Promise.resolve(null),
      objectUrl: null,
      controller,
      refs: 0,
      idleTimer: null,
    };
    created.url = load(controller.signal)
      .catch(() => null)
      .then((blob) => {
        if (photos.get(key) !== created || controller.signal.aborted) return null;
        if (!blob) {
          // A failed read is not remembered: the next holder tries again.
          photos.delete(key);
          return null;
        }
        created.objectUrl = URL.createObjectURL(blob);
        return created.objectUrl;
      });
    photos.set(key, created);
    entry = created;
  }
  const held = entry;
  held.refs += 1;
  if (held.idleTimer) {
    clearTimeout(held.idleTimer);
    held.idleTimer = null;
  }
  let released = false;
  return {
    url: held.url,
    release: () => {
      if (released) return;
      released = true;
      held.refs -= 1;
      if (held.refs > 0 || photos.get(key) !== held) return;
      held.idleTimer = setTimeout(() => evictPhoto(key, held), PHOTO_IDLE_MS);
    },
  };
}

/** One appearance read per (account, relationship) until an appearance is saved. */
export function readSharedCharacterAppearance(
  account: string,
  relationshipId: string,
): Promise<CharacterAppearance> {
  listenOnce();
  const key = `${account}\0${relationshipId}`;
  const cached = appearances.get(key);
  if (cached) return cached;
  const read = getCharacterAppearance(relationshipId);
  appearances.set(key, read);
  read.catch(() => {
    if (appearances.get(key) === read) appearances.delete(key);
  });
  return read;
}
