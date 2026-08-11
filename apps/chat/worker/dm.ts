// Direct messages: the rules Chat's Worker enforces on the DM path.
//
// A DM is a two-person conversation backed by the same RoomDO as a group, addressed by a
// deterministic id derived from the two account ids (see dmRoomCode). Reusing the DO is what
// gives DMs history retention, media and the wire protocol for free instead of a second
// implementation of all three.
//
// This module deliberately imports nothing from `cloudflare:workers`, for the same reason
// group.ts does not: RoomDO cannot be loaded in the app's vitest run, so every rule worth
// testing lives here as a pure function and RoomDO/index.ts only call them.
//
// The token format itself is *not* defined here. It is imported from the account service,
// which mints it — one implementation, verified in the other Worker rather than reimplemented
// there.
import {
  DM_TICKET_TTL_MS,
  dmRoomCode,
  isDmRoomCode,
  verifyDmTicket,
  type DmTicketClaims,
} from '../../../workers/auth/src/dm-ticket';

export {
  DM_DIGEST_MAX_ROOMS,
  DM_ROOM_PREFIX,
  DM_TICKET_TTL_MS,
  dmRoomCode,
  isDmRoomCode,
} from '../../../workers/auth/src/dm-ticket';

/**
 * The two frames a conversation does not have, kept in one place so the difference between a
 * conversation and a group is stated once rather than scattered through RoomDO's switch.
 *
 * `group` carries lobby visibility, and a conversation must never become listed. `agent` is a
 * room AI defined by a group's owner, and a conversation has no owner. Both would already be
 * refused, since the owner check falls back to the host and a conversation elects none, but
 * that is a distant absence to rely on and the cost of it changing is a private conversation
 * showing up in the public lobby.
 *
 * Everything else routes exactly as it does in a group, because a conversation *is* a room
 * with two people in it. In particular the safety chain is untouched and unreachable from
 * here: strength limits are applied by the device's own holder, commands go through the serial
 * queue, and AI-issued ones go through the policy engine — all of that lives in the client
 * that owns the device, not in this relay, so routing a frame here changes none of it.
 */
const DM_REMOVED_FRAMES: ReadonlySet<string> = new Set(['group', 'agent']);

/** Whether a conversation relays this frame type. */
export function dmAllowsFrame(t: string): boolean {
  return !DM_REMOVED_FRAMES.has(t);
}

/**
 * Whether the group WebSocket path may serve this code.
 *
 * `/ws/room/:code` takes the code straight from the URL and needs no credential, so without
 * this a DM's Durable Object would be reachable by anyone who could name it — the ticket check
 * on `/ws/dm` would be decoration. The DM path never takes a code from the client at all; it
 * reads it out of the signed ticket.
 */
export function roomPathAllowsCode(code: string): boolean {
  return !isDmRoomCode(code);
}

/**
 * Is a ticket minted before this conversation's revocation mark?
 *
 * Blocking deletes the follows, so no *new* ticket can be minted — but a ticket already in a
 * client's hands stays valid for the rest of its minute, and a socket opened before the block
 * would otherwise stay open indefinitely. Auth pushes a revocation when a block lands; the
 * conversation records when, and every ticket issued at or before that moment is dead. Storing
 * the instant rather than a flag is what makes unblocking need no second message: a ticket
 * minted afterwards is newer than the mark and simply passes.
 */
export function dmTicketRevoked(iat: number, revokedAt: number | undefined): boolean {
  return revokedAt !== undefined && iat <= revokedAt;
}

export type DmAuthFailure = { ok: false; status: number; message: string };

export type DmUpgradeAuth =
  { ok: true; code: string; iat: number; self: string; peer: string } | DmAuthFailure;

/**
 * Decide whether a WebSocket upgrade may enter a DM's Durable Object.
 *
 * This runs in the Worker, before the stub is ever touched — the mutual-follow check the
 * account service performed is what the ticket attests to, and an upgrade that cannot present
 * one never reaches the conversation.
 *
 * The room code is re-derived from the ticket's own `sub` and `peer` rather than trusted as
 * written. Both are signed, so this cannot be triggered by a client; it means a minting bug
 * that put the wrong room in a ticket routes two people into a *nonexistent* conversation
 * instead of into somebody else's.
 */
export async function authorizeDmUpgrade(params: {
  secret: string | undefined;
  ticket: string | null;
  now: number;
}): Promise<DmUpgradeAuth> {
  const { secret, ticket, now } = params;
  // Absent secret means the deployment never configured DMs. Refusing loudly beats falling
  // back to "let everyone in", which is what a missing-credential path usually degrades into.
  if (!secret) return { ok: false, status: 503, message: 'dm not configured' };
  if (!ticket) return { ok: false, status: 401, message: 'dm ticket required' };

  const claims = await verifyDmTicket(secret, ticket, now);
  if (!claims || claims.aud !== 'dm') return { ok: false, status: 403, message: 'invalid ticket' };
  if (!claims.room || !claims.peer) return { ok: false, status: 403, message: 'invalid ticket' };
  if (!isDmRoomCode(claims.room)) return { ok: false, status: 403, message: 'invalid ticket' };
  if ((await dmRoomCode(secret, claims.sub, claims.peer)) !== claims.room) {
    return { ok: false, status: 403, message: 'invalid ticket' };
  }
  return { ok: true, code: claims.room, iat: claims.iat, self: claims.sub, peer: claims.peer };
}

export type DmClaimsAuth = { ok: true; claims: DmTicketClaims } | DmAuthFailure;

/** Check a ticket minted for some audience other than joining (digest / revoke). */
export async function authorizeDmToken(params: {
  secret: string | undefined;
  token: string | null;
  audience: 'digest' | 'revoke' | 'chat';
  now: number;
}): Promise<DmClaimsAuth> {
  const { secret, token, audience, now } = params;
  if (!secret) return { ok: false, status: 503, message: 'dm not configured' };
  if (!token) return { ok: false, status: 401, message: 'token required' };
  const claims = await verifyDmTicket(secret, token, now);
  if (!claims || claims.aud !== audience) {
    return { ok: false, status: 403, message: 'invalid token' };
  }
  return { ok: true, claims };
}

/** Claims for a freshly minted ticket, so mint sites cannot disagree about the TTL. */
export function dmTicketWindow(now: number): { iat: number; exp: number } {
  return { iat: now, exp: now + DM_TICKET_TTL_MS };
}

/** One conversation's state, as the sidebar needs it. */
export interface DmSummary {
  room: string;
  /** Timestamp of the newest retained message, or 0 for a conversation with nothing in it. */
  lastTs: number;
  /** Messages newer than the `since` the client asked with. */
  unread: number;
}
