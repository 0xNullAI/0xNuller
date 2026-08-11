/**
 * Direct-message admission tokens.
 *
 * A DM is two accounts talking in a RoomDO. The account service owns the follow
 * graph; Chat's Worker owns the conversation and knows nothing about accounts. So
 * something has to carry "these two are allowed to talk" from here to there, and
 * this file is that statement's format. It lives with the service that mints it so
 * there is exactly one implementation: Chat imports this module and only ever calls
 * `verifyDmTicket`. Two copies of a token format is how a signature check ends up
 * accepting something the signer never meant.
 *
 * ## Why a signed ticket rather than Chat asking auth over a service binding
 *
 * A service binding is the obvious design and it fails for a mechanical reason: the
 * credential cannot reach Chat. A DM opens over a WebSocket, and the browser
 * WebSocket API cannot set an Authorization header. On the web a same-origin
 * upgrade would carry the session cookie, but the Android shell's origin is a local
 * scheme and can never hold a cookie for the web domain — the same constraint that
 * made this service accept Bearer tokens in the first place. The only carrier that
 * works on both is something the client can put in the URL, and something in a URL
 * has to be unforgeable and short-lived.
 *
 * The binding still exists, in the other direction: auth pushes a revocation to
 * Chat when a block lands. Pushing a fact is a different problem from pulling a
 * credential, and it has no WebSocket in the way.
 *
 * ## What an attacker who forges the client can and cannot do
 *
 * **Cannot mint one.** HMAC-SHA256 under a secret only the two Workers hold. A
 * forged client may flip any bit of the payload; the tag stops matching. It cannot
 * address a conversation it was not admitted to, name a different peer, or extend
 * its own expiry.
 *
 * **Cannot guess a conversation id.** The room code is an HMAC of the two account
 * ids, not a plain hash of them. Account ids are discoverable — looking someone up
 * by username returns theirs — so a plain hash would let anyone who knows both ids
 * compute the conversation's R2 media prefix, which is served unauthenticated the
 * way every room's is. Keying it closes that.
 *
 * **Can keep a ticket it legitimately obtained until it expires**, including
 * through a block landing inside that window. That is exactly why blocking pushes
 * an immediate revocation instead of relying on the TTL.
 *
 * **Can replay its own ticket elsewhere.** A ticket is a bearer token, bound to no
 * IP and no TLS session. Stealing one is as bad as stealing the session it was
 * minted from, and no worse — it grants one conversation for one minute where the
 * session grants the whole account for thirty days.
 *
 * ## The secret must never be rotated
 *
 * `dmRoomCode` keys the conversation id with it, so a new secret moves every
 * conversation to a different Durable Object and orphans all DM history. Same rule
 * as IP_PEPPER, for a different reason and with worse consequences.
 */

/** Prefix marking a RoomDO instance as a two-person conversation rather than a group. */
export const DM_ROOM_PREFIX = 'dm:';

/**
 * How long a minted ticket stays valid.
 *
 * This is the window in which the follow graph and the sockets Chat is holding open
 * may disagree, so it is short. The client re-mints on every reconnect rather than
 * holding one for the life of the conversation, which is what makes admission a
 * repeated check against live data instead of a one-time gate.
 */
export const DM_TICKET_TTL_MS = 60_000;

/**
 * Tolerance for the two Workers' clocks disagreeing. Cloudflare's are NTP-synced,
 * so this only has to absorb the flight time of the request carrying the ticket.
 */
export const DM_CLOCK_SKEW_MS = 5_000;

/** Most conversations one digest ticket may cover; bounds the Durable Object fan-out behind it. */
export const DM_DIGEST_MAX_ROOMS = 50;

/**
 * What a ticket is for. Separating them means a ticket obtained for one purpose
 * cannot be presented for another — reading the unread counts of every conversation
 * you have is not the same permission as joining one of them.
 */
export type DmTicketAudience = 'dm' | 'digest' | 'revoke' | 'voice' | 'chat';

export interface DmTicketClaims {
  aud: DmTicketAudience;
  /** Account id the ticket was minted for. On a 'revoke' this is the account that caused it. */
  sub: string;
  /** Conversation this admits to. Present for 'dm' and 'revoke'. */
  room?: string;
  /** The other account, present for 'dm' — it is what makes `room` re-derivable and therefore checkable. */
  peer?: string;
  /** Conversations a 'digest' may ask about. */
  rooms?: string[];
  /** Minted at (epoch ms). Chat compares this against a conversation's revocation mark. */
  iat: number;
  /** Expires at (epoch ms). */
  exp: number;
}

/** Is this RoomDO instance a DM? Derived from the id itself, so it survives hibernation. */
export function isDmRoomCode(code: string): boolean {
  return code.startsWith(DM_ROOM_PREFIX);
}

/**
 * The conversation id for a pair of accounts.
 *
 * Sorted, so the same two people always land on the same Durable Object no matter
 * who opened it. Keyed rather than hashed, so knowing both account ids is not
 * enough to address the conversation — see the note on media above.
 */
export async function dmRoomCode(secret: string, a: string, b: string): Promise<string> {
  const [first, second] = [a, b].sort();
  return DM_ROOM_PREFIX + hex(await hmac(secret, `dm\n${first}\n${second}`));
}

/** Mint a ticket. The claims are visible to the bearer; only the tag is secret. */
export async function signDmTicket(secret: string, claims: DmTicketClaims): Promise<string> {
  const payload = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  return `${payload}.${b64url(await hmac(secret, payload))}`;
}

/**
 * Check a ticket and return its claims, or null.
 *
 * Null for every failure, deliberately without saying which: the caller answers a
 * bad signature and an expired ticket the same way, and a client that can tell them
 * apart learns whether it guessed the secret's shape right.
 */
export async function verifyDmTicket(
  secret: string,
  token: string,
  now: number,
): Promise<DmTicketClaims | null> {
  if (!secret || !token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const tag = token.slice(dot + 1);
  if (!timingSafeEqual(b64url(await hmac(secret, payload)), tag)) return null;

  const raw = fromB64url(payload);
  if (!raw) return null;
  let claims: DmTicketClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(raw)) as DmTicketClaims;
  } catch {
    return null;
  }
  if (typeof claims?.sub !== 'string' || !claims.sub) return null;
  if (typeof claims.iat !== 'number' || typeof claims.exp !== 'number') return null;
  // A ticket from the future is either a clock problem or an attempt to sit on one
  // until its window opens; neither is a reason to accept it.
  if (claims.iat > now + DM_CLOCK_SKEW_MS) return null;
  if (claims.exp <= now - DM_CLOCK_SKEW_MS) return null;
  return claims;
}

// -- Internals --

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array | null {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Compare without leaking how far the match got. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
