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
  | 'scene' // scene: the host sets/changes it (client→DO); current scene + host broadcast (DO→client)
  | 'role' // role: claim/release (client→DO); role→peer assignment broadcast (DO→client)
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
  /** Snapshot of the sender's role title at the time (absent = an ordinary member). */
  senderRole?: string;
  /** Send timestamp in milliseconds. */
  ts: number;
}

/** Scene role definition. */
export interface SceneRole {
  id: string;
  /** Role name (= the member's title). */
  name: string;
  /** Role description / persona: shown to members, and also used as the persona prompt when the role is handed to the AI. */
  description?: string;
  /** Whether this role can be played by the AI (flagged when the scene is uploaded; the host uses it to show the 「交给 AI」 entry point). */
  aiPlayable?: boolean;
}

/** Room scene (setting + roles + gameplay metadata). */
export interface Scene {
  id: string;
  name: string;
  /** Setting / background description. */
  setting: string;
  roles: SceneRole[];
  /** Suggested player count (filled in on Market upload; the room may optionally show it). */
  playerCount?: { min?: number; max?: number };
}

/** DO→client: current scene + host. A null scene means no scene has been set. */
export interface WireScene {
  t: 'scene';
  scene: Scene | null;
  host: string; // hostPeerId
}

/** DO→client: role→peer claim assignments (authoritative state). */
export interface WireRole {
  t: 'role';
  assignments: Record<string, string>; // roleId -> peerId
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

/** Grace period before an emptied room is cleaned up (milliseconds). */
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
