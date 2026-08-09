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
  | 'agent' // room agent: the host sets/clears it (client→DO); current agent + host broadcast (DO→client)
  | 'group' // group settings: the owner changes them (client→DO); current settings (DO→client)
  // The roleplay feature is gone, but pre-removal Android builds still send these two.
  // They stay listed here permanently so RoomDO keeps an explicit no-op case for them
  // rather than letting them fall through to the relay-everything default.
  | 'scene' // legacy roleplay, dropped by the DO
  | 'role' // legacy roleplay, dropped by the DO
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
export interface WireChat {
  /** Message type marker (always 'chat' in the broadcast body). */
  t?: 'chat';
  id: string;
  /** Sender peerId (injected by the DO, therefore trusted). */
  _from?: string;
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
}

/**
 * The room's AI participant.
 *
 * Exactly one per room, addressed by @-mention. It replaced a system where
 * the AI was modelled as a *claimed scene role*, which meant its identity,
 * its persona and its permission to speak all came from a scene definition
 * — and so did the ability to @ it at all.
 *
 * Its sender id is fixed (`ai:room`). Keeping the `ai:` prefix is what lets
 * the self-loop guard, the isAi member flag, and the server-side `as` check
 * stay exactly as they were.
 */
export interface RoomAgent {
  /** Shown in the room and in the @ list. */
  name: string;
  /** Free-text persona, written by the host. Becomes the system prompt. */
  persona: string;
}

/** The room agent's fixed member id. */
export const ROOM_AGENT_ID = 'room';

/** The room agent's fixed sender id, as it appears in `as` and in `senderId`. */
export const ROOM_AGENT_SENDER = `ai:${ROOM_AGENT_ID}`;

/** DO→client: the room's agent. Null means the host has not added one. */
export interface WireAgent {
  t: 'agent';
  agent: RoomAgent | null;
  host: string; // hostPeerId
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
  code: string;
  /** Display name; only meaningful while the group is public (that is where it shows). */
  name?: string;
  /** Whether the group is listed in the lobby. */
  public?: boolean;
  /** Whether the group has an owner key on file at all. */
  owned?: boolean;
  /** Whether *this* connection proved ownership. Per-connection, never broadcast. */
  isOwner?: boolean;
  /** The minted key, sent exactly once to the connection that created the group. */
  ownerKey?: string;
}

/** Longest group name the DO will store. */
export const MAX_GROUP_NAME = 60;

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
  kind: 'joined' | 'left';
  peerId: string;
}

/** history frame sent from the DO to the client. */
export interface WireHistory {
  t: 'history';
  messages: WireChat[];
}

/** Fixed name of the singleton lobby DO. */
export const LOBBY_NAME = 'v1';

/**
 * How long after the last member leaves the group runs its idle housekeeping (milliseconds).
 *
 * This used to be the countdown to the group deleting itself. Groups are permanent now, so
 * nothing is deleted when it fires; it is the quiet moment in which the media sweep runs,
 * and it doubles as the age below which an unreferenced R2 object is assumed to be an
 * upload whose chat message has not landed yet rather than an orphan.
 */
export const ROOM_GRACE_MS = 10 * 60 * 1000;

/** The official public discussion room permanently resident in the lobby: always public, never cleaned up, listed at the top of the lobby even when empty. */
export { RESERVED_ROOM_CODE } from '../shared/room-constants.js';
export const RESERVED_ROOM_NAME = '0xNullAI 公开讨论区';

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
