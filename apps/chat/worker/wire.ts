// DG-Chat WebSocket wire protocol.
// MQTT used to distinguish message types by topic; that is now folded into the `t` field
// of a single WS message and routed by RoomDO.
// This file is pure types + constants with no runtime dependencies, so it can be shared by
// the Worker and (by reference) the frontend.

/** Message types inside a room. */
export type WireType =
  | 'hello' // client→DO, first frame on join: declares nickname / whether public / room name
  | 'chat' // chat message (persisted into history, with an optional media reference)
  | 'sf' // state.fast: strength/waveform/firing, broadcast
  | 'ss' // state.slow: name/battery/queue/catalog, broadcast
  | 'presence' // nickname heartbeat (lightweight, broadcast)
  | 'cmd' // device command, directed (to=peerId)
  | 'wave' // waveform transfer, directed (to=peerId)
  | 'leave' // voluntary leave
  | 'agent-error' // DO→client: rejected agent configuration; persisted configuration is unchanged
  | 'agent' // room agent: the host sets/clears it (client→DO); current agent + host broadcast (DO→client)
  | 'agent-billing' // owner selects explicit host BYOK or member-paid managed mode
  | 'agent-run-status' // DO→payer: a managed group turn could not complete
  | 'group' // group settings: the owner changes them (client→DO); current settings (DO→client)
  | 'media-auth' // DO→client: capability for uploads while this WebSocket remains connected
  // The roleplay feature is gone, but pre-removal Android builds still send these two.
  // They stay listed here permanently so RoomDO keeps an explicit no-op case for them
  // rather than letting them fall through to the relay-everything default.
  | 'scene' // legacy roleplay, dropped by the DO
  | 'role' // legacy roleplay, dropped by the DO
  | 'history-before' // client→DO: request an older bounded page
  | 'search' // client→DO: text search over retained history
  | 'search-result' // DO→client: newest-first matches for one search request
  | 'recall' // client→DO: withdraw one's own message; DO→client: { id } was recalled
  | 'history' // DO→client: replay for a newly joined peer
  | 'sys'; // DO→client: connection-level presence (joined/left)

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
 * The room's AI participant.
 *
 * Exactly one per room, addressed by @-mention. It replaced a system where
 * the AI was modelled as a *claimed scene role*, which meant its identity,
 * its persona and its permission to speak all came from a scene definition
 * — and so did the ability to @ it at all.
 *
 * New rooms use `ai:room`. Old rooms with no primary may keep the first
 * additional role's sender id; the `ai:` prefix still identifies all AI messages.
 */
export interface NamedRoomAgent extends RoomAgent {
  id: string;
}

export const MAX_ROOM_AGENTS = 1;

export function validRoomAgents(value: unknown): value is NamedRoomAgent[] {
  if (!Array.isArray(value) || value.length > MAX_ROOM_AGENTS) return false;
  const ids = new Set<string>();
  return value.every((agent) => {
    if (
      !agent ||
      typeof agent !== 'object' ||
      typeof agent.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(agent.id) ||
      ids.has(agent.id) ||
      typeof agent.name !== 'string' ||
      !agent.name.trim() ||
      agent.name.trim().length > MAX_ROOM_AGENT_NAME ||
      typeof agent.persona !== 'string' ||
      agent.persona.length > MAX_ROOM_AGENT_PERSONA
    )
      return false;
    ids.add(agent.id);
    return true;
  });
}

export interface RoomAgent {
  /** Shown in the room and in the @ list. */
  name: string;
  /** Free-text persona, written by the host. Becomes the system prompt. */
  persona: string;
}

/** Shared transport limits; imported scenes must fit without truncation. */
export const MAX_ROOM_AGENT_NAME = 40;
export const MAX_ROOM_AGENT_PERSONA = 4000;

/** The room agent's fixed member id. */
export const ROOM_AGENT_ID = 'room';

/** The room agent's fixed sender id, as it appears in `as` and in `senderId`. */
export const ROOM_AGENT_SENDER = `ai:${ROOM_AGENT_ID}`;

/** DO→client: the room's agent. Null means the host has not added one. */
export interface WireAgent {
  t: 'agent';
  agent: RoomAgent | null;
  agents?: NamedRoomAgent[];
  host: string; // hostPeerId
  billingMode?: 'host-byok' | 'managed';
}

export type RoomAgentBillingMode = 'host-byok' | 'managed';

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

/** Envelope sent from the client to the DO (apart from hello, business fields are flat at the top level). */
export interface WireInbound {
  t: WireType;
  /** Target peerId for a directed message (cmd/wave). */
  to?: string;
  /** Arbitrary business fields (chat's x/m, sf/ss state fields, cmd's a/c/v, ...). */
  [k: string]: unknown;
}

/** sys frame sent from the DO to the client. */
export interface WireSys {
  t: 'sys';
  kind: 'joined' | 'left' | 'owner-assigned' | 'closed' | 'membership-revoked';
  peerId?: string;
}

/** history frame sent from the DO to the client. */
export interface WireHistory {
  t: 'history';
  messages: WireChat[];
  older?: boolean;
  before?: { ts: number; id: string } | null;
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
