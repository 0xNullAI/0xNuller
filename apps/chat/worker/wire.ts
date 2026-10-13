// DG-Chat WebSocket wire protocol.
// MQTT used to distinguish message types by topic; that is now folded into the `t` field
// of a single WS message and routed by RoomDO.
// This file is pure types + constants with no runtime dependencies, so it can be shared by
// the Worker and (by reference) the frontend.

/** Media reference (image/audio). The blob lives in R2; the message only carries the reference. */
export interface MediaRef {
  kind: 'image' | 'audio';
  /** R2 object id (without the room prefix; the extension is inferred from mime). */
  id: string;
  mime: string;
  size: number;
  /** Audio duration in milliseconds; images may carry width/height. */
  durationMs?: number;
  w?: number;
  h?: number;
}

/** Persisted chat message (DO SQLite row ↔ history replay ↔ chat broadcast body).
 *  Note: `t` is the envelope's message type ('chat') and the timestamp is `ts`; the two
 *  must not be mixed up. */
export interface WireReply {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  unavailable?: boolean;
  /** The quoted message was withdrawn by its sender. */
  recalled?: true;
}

/** How long after sending a member may withdraw their own message. */
export const RECALL_WINDOW_MS = 2 * 60_000;

export interface WireChat {
  /** Server-resolved reference; only the source ID is persisted. */
  replyTo?: WireReply;
  /** Message type marker (always 'chat' in the broadcast body). */
  t?: 'chat';
  id: string;
  /** Sender peerId (injected by the DO, therefore trusted). */
  _from?: string;
  /**
   * Sender account (injected by the DO). Peer ids change on every page load; this is what
   * lets a client recognise its own messages in history from any device.
   */
  _account?: string;
  /** Snapshot of the sender's nickname. */
  n: string;
  /** Text body (may be empty for a media message). */
  x?: string;
  /** Media reference. */
  m?: MediaRef;
  /** Members that were @-mentioned (peerId + nickname snapshot). */
  mentions?: { peerId: string; n: string }[];
  /** Send timestamp in milliseconds. */
  ts: number;
  /** Withdrawn by its sender: x, m and mentions are absent. */
  recalled?: true;
}

/**
 * A group AI. Each one belongs to the member who brought it in: it is that member's own
 * character, it runs only on the server, and only that member's Credit pays for it. Any
 * member may @ it. The `ai:` sender prefix identifies every AI message.
 *
 * Groups from before AIs had owners used the fixed id `room` (or an old additional role's
 * id); migration keeps that id so the history still reads as the same speaker.
 */
export interface NamedRoomAgent extends RoomAgent {
  id: string;
}

export interface RoomAgent {
  /** Shown in the room and in the @ list. */
  name: string;
  /** Persona text copied from the owner's character when it joined. */
  persona: string;
}

/** Shared transport limits; imported characters must fit without truncation. */
export const MAX_ROOM_AGENT_NAME = 40;
export const MAX_ROOM_AGENT_PERSONA = 4000;

/** Most AIs one group holds; each member may bring one. */
export const MAX_GROUP_AGENTS = 3;

/** The sender id pre-ownership groups used for their single AI. */
export const LEGACY_ROOM_AGENT_ID = 'room';

/** A group AI as every member sees it. */
export interface WireRoomAgent extends NamedRoomAgent {
  /** Owner account id; the same id members already see on chat frames. */
  owner: string;
  ownerName: string;
  /** Credit per day the owner allows in this group; null when only the balance limits it. */
  dailyCap: number | null;
}

/**
 * DO→client: the group's AIs.
 *
 * `agent`, `host` and `billingMode` are only for clients from before AIs had owners. An
 * empty host and `managed` keep such a client from trying to run an AI in its browser.
 */
export interface WireAgent {
  t: 'agent';
  agents: WireRoomAgent[];
  agent: RoomAgent | null;
  host: '';
  billingMode: 'managed';
}

/**
 * DO→client: the group's durable settings.
 *
 * Fields are optional on purpose and the client must treat an absent one as "unchanged".
 * `isOwner` and `ownerKey` are answers to one specific connection and are therefore never
 * part of the broadcast that follows a settings change — the room learns that the group
 * went public, not who made it so, and certainly not with what key.
 */
export interface WireGroup {
  t: 'group';
  persistentHistory?: boolean;
  code: string;
  /** Display name; only meaningful while the group is public (that is where it shows). */
  name?: string;
  /** Whether the group is listed in the lobby. */
  public?: boolean;
  /** Whether the group is bound to an owner account. */
  owned?: boolean;
  /** Whether *this* connection proved ownership. Per-connection, never broadcast. */
  isOwner?: boolean;
  /** Legacy: older workers sent a minted owner key once. New workers never send it. */
  ownerKey?: string;
}

/** Longest group name the DO will store. */
export const MIN_GROUP_NAME = 4;
export const MAX_GROUP_NAME = 40;
/** Every group, long-term or not, is recycled after this long with nobody connected. */
export const ROOM_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

export function validGroupName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length >= MIN_GROUP_NAME &&
    value.trim().length <= MAX_GROUP_NAME
  );
}

/** Fixed name of the singleton lobby DO. */
export const LOBBY_NAME = 'v1';

/**
 * How long after the last member leaves the group runs its idle housekeeping (milliseconds).
 *
 * This interval schedules media housekeeping; ROOM_IDLE_MS controls room expiration, so
 * nothing is deleted when it fires; it is the quiet moment in which the media sweep runs,
 * and it doubles as the age below which an unreferenced R2 object is assumed to be an
 * upload whose chat message has not landed yet rather than an orphan.
 */
export const ROOM_GRACE_MS = 10 * 60 * 1000;

/** The official public discussion room permanently resident in the lobby: always public, never cleaned up, listed at the top of the lobby even when empty. */

/** Upper bound on uploaded media size (bytes). */
export const MAX_MEDIA_BYTES = 8 * 1024 * 1024;

/**
 * Media types accepted for upload, as an exact allow-list.
 *
 * It used to be the prefixes `image/` and `audio/`, which admit
 * `image/svg+xml` — and an SVG is a document that can carry <script>. The
 * upload endpoint takes no auth, and read-back serves the file inline from
 * the app's own origin with the type it was uploaded under, so an attacker
 * could park script on the origin that holds the session cookie.
 *
 * Only formats the client actually produces are listed: images are always
 * re-encoded through canvas.toBlob to JPEG, and the recorder picks from the
 * webm/mp4/aac set. The extra raster types cover paths that may forward an
 * original file. Nothing here can execute.
 */
export const ALLOWED_MEDIA_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'audio/webm',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/wav',
];

/**
 * Whether a Content-Type header may be stored.
 *
 * Compares the bare type: the recorder sends `audio/webm;codecs=opus`, and
 * a parameter must not be a way to smuggle a type past the check.
 */
export function isAllowedMediaType(header: string | null): boolean {
  if (!header) return false;
  const bare = header.split(';')[0]!.trim().toLowerCase();
  return ALLOWED_MEDIA_TYPES.includes(bare);
}

export interface DmInboxSummary {
  room: string;
  lastMessageAt: number | null;
  preview: string;
  unread: number | null;
  lastSequence: number;
  readSequence: number | null;
}

export type GroupMembershipState = 'active' | 'left' | 'removed' | 'banned';
export interface GroupMembership {
  account_id: string;
  name: string;
  state: GroupMembershipState;
  version: number;
  updated_at: number;
}
