// Group ownership and orphaned-media housekeeping: rules that have to outlive a session.
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
