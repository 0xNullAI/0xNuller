// Group ownership and history retention: the two rules that have to outlive a session.
//
// This module deliberately imports nothing from `cloudflare:workers`. RoomDO cannot be
// imported into the app's vitest run (that specifier only resolves inside workerd), so
// everything worth testing lives here behind small ports that RoomDO implements over
// SqlStorage and R2, and that tests implement over plain arrays.

/**
 * Hash a legacy owner key the way older Chat Workers stored it (`code:key`, SHA-256).
 *
 * New groups no longer mint keys; ownership belongs to an account. The hash stays so a
 * legacy key holder can still prove ownership once and bind the group to their account.
 */
export async function hashOwnerKey(code: string, key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${code}:${key}`));
  return hex(new Uint8Array(digest));
}

/**
 * Who is allowed to change a group's settings.
 *
 * Product rule (2026-10-11): every group has exactly one owner, and that owner is an
 * account. Once `ownerAccountId` is set, only that signed-in account administers the group;
 * a browser-held owner key or the live host role grants nothing.
 *
 * A legacy group that has an owner key but no owner account yet still accepts the key, so
 * the key holder can reconnect and bind the group to their account (see
 * `resolveGroupOwner`). peerId and host never administer: they last one session.
 */
export async function canAdministerGroup(params: {
  code: string;
  ownerAccountId: string | null;
  senderAccountId: string | undefined;
  ownerKeyHash: string | null;
  presentedKey: unknown;
}): Promise<boolean> {
  const { code, ownerAccountId, senderAccountId, ownerKeyHash, presentedKey } = params;
  if (ownerAccountId) return !!senderAccountId && senderAccountId === ownerAccountId;
  if (!ownerKeyHash || typeof presentedKey !== 'string' || !presentedKey) return false;
  return timingSafeEqual(await hashOwnerKey(code, presentedKey), ownerKeyHash);
}

/**
 * Decide whether a signed-in member's hello binds the group to an owner account.
 *
 * - Already bound: nothing changes.
 * - New group (`claim`) or legacy group with a key the member proves: the member's account.
 * - Legacy group with neither an owner key nor an owner account: the first signed-in member
 *   to reconnect becomes the owner, so no group is left without one.
 * - Legacy group with an owner key the member does not prove: wait for the key holder.
 */
export async function resolveGroupOwner(params: {
  code: string;
  ownerAccountId: string | null;
  ownerKeyHash: string | null;
  senderAccountId: string | undefined;
  claim: boolean;
  presentedKey: unknown;
}): Promise<string | null> {
  const { code, ownerAccountId, ownerKeyHash, senderAccountId, claim, presentedKey } = params;
  if (ownerAccountId || !senderAccountId) return null;
  if (!ownerKeyHash) return senderAccountId;
  if (claim) return null;
  if (typeof presentedKey !== 'string' || !presentedKey) return null;
  return timingSafeEqual(await hashOwnerKey(code, presentedKey), ownerKeyHash)
    ? senderAccountId
    : null;
}

/**
 * How many messages a group keeps.
 *
 * A group is permanent now, so something has to bound it; a Durable Object's SQLite is
 * not infinite and R2 media is no longer cleaned up by a room dying. The cap is expressed
 * in messages rather than bytes or days because it is the one unit that bounds all three
 * costs at once:
 *
 *  - Storage: a row is a few hundred bytes, so 1000 of them is well under a megabyte, and
 *    the media hanging off them is deleted in the same step (see enforceMessageRetention),
 *    which caps the R2 side too instead of letting it grow behind the rows.
 *  - Replay: the whole retained history is pushed to every joining connection in one
 *    `history` frame, on every reconnect. 1000 messages is a couple of hundred kilobytes;
 *    an uncapped group would eventually make joining it a download.
 *  - Product: this is the QQ-group behaviour people expect — recent history is there,
 *    the backlog from a year ago is not. A time-based rule would fail the opposite way,
 *    keeping nothing for a quiet group and everything for a busy one.
 *
 * One number, used for both retention and replay, so what is stored and what a joiner
 * sees can never drift apart.
 */
export const GROUP_MESSAGE_LIMIT = 1000;

/** A retained message as retention sees it: an id, plus the media that dies with it. */
export interface RetainedMessage {
  id: string;
  /** R2 object id referenced by this message, or null for a text-only message. */
  mediaId: string | null;
}

/** The message rows retention needs to touch (RoomDO implements this over SqlStorage). */
export interface MessageStore {
  count(): number;
  /** The `n` oldest messages, oldest first. */
  oldest(n: number): RetainedMessage[];
  remove(ids: string[]): void;
}

/** The media objects retention needs to touch (RoomDO implements this over R2). */
export interface MediaStore {
  delete(ids: string[]): Promise<void>;
}

/**
 * Drop the oldest messages until the group is back at `limit`, taking their media with them.
 *
 * Media is deleted *before* the rows: if R2 fails the rows survive, the group is still over
 * the cap, and the next message retries. The reverse order would drop the only remaining
 * pointer to the object and leak it. Returns the ids that were dropped.
 */
export async function enforceMessageRetention(
  messages: MessageStore,
  media: MediaStore,
  limit: number = GROUP_MESSAGE_LIMIT,
): Promise<string[]> {
  const excess = messages.count() - limit;
  if (excess <= 0) return [];
  const doomed = messages.oldest(excess);
  if (doomed.length === 0) return [];
  const mediaIds = doomed.map((m) => m.mediaId).filter((id): id is string => !!id);
  if (mediaIds.length > 0) await media.delete(mediaIds);
  const ids = doomed.map((m) => m.id);
  messages.remove(ids);
  return ids;
}

/** An object sitting in the group's R2 prefix. */
export interface StoredMediaObject {
  id: string;
  uploadedAt: number;
}

/**
 * Media in the bucket that no retained message points at any more.
 *
 * Two ways an object gets here: retention dropped its row but the R2 delete failed, or
 * someone uploaded an attachment and closed the tab before sending it — the upload
 * endpoint is what writes to R2, and nothing else ever learns that id. Both used to be
 * swept up by the room deleting itself, which no longer happens.
 *
 * `uploadedBefore` is what keeps this from racing a live upload: an object younger than
 * that has a chat message plausibly still in flight behind it.
 */
export function orphanMediaIds(
  objects: StoredMediaObject[],
  referenced: ReadonlySet<string>,
  uploadedBefore: number,
): string[] {
  return objects
    .filter((o) => !referenced.has(o.id) && o.uploadedAt < uploadedBefore)
    .map((o) => o.id);
}

// -- Internals --

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Compare two hex digests without leaking how far the match got. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
