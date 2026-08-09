// P2P message protocol type definitions.
// Public types (used by the UI) keep long field names; the wire format (inside
// use-peer-room) uses short keys to shrink the payload.

import type { DeviceKind } from '@dg-kit/core';

// Re-exported so components (SensorCard/OpossumControl/LedColorPicker, ...) reference the
// same enum instead of each importing '@dg-kit/core' on their own. Note: this is the BLE
// device kind enum itself (the room protocol uses it as the "which device is this command
// for" routing discriminator), not a new room-protocol concept.
export type { DeviceKind };

/** Media attached to a chat message (image/audio). The blob lives in R2; this holds the already-resolved, directly accessible URL. */
export interface ChatMedia {
  kind: 'image' | 'audio';
  /** Accessible address after resolving `/api/media/:code/:id`. */
  url: string;
  mime: string;
  /** Audio duration in milliseconds. */
  durationMs?: number;
  /** Image width/height in pixels. */
  w?: number;
  h?: number;
}

/** A member @-mentioned in a message. */
export interface ChatMention {
  peerId: string;
  displayName: string;
}

export interface ChatMessage {
  id: string;
  fromSelf: boolean;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  media?: ChatMedia;
  /** List of @-mentioned members (used for highlighting + notification). */
  mentions?: ChatMention[];
  /** The sender's role title at the time (when playing a scene). */
  senderRole?: string;
}

export type CmdAction =
  | 'adjust_strength' // v=signed delta; the owner accumulates prev+delta and clamps to [0, limit], safe with multiple controllers
  | 'change_wave'
  | 'start'
  | 'stop'
  | 'stop_wave'
  | 'burst'
  | 'vibrate'
  | 'alert'
  | 'bg'
  | 'shake'
  | 'beep'
  | 'set_queue'
  | 'set_play_mode'
  | 'set_interval'
  | 'fire_active' // heartbeat: once every 300ms while the controller holds the button, v=boost; the owner treats 800ms without a refresh as a release
  | 'fire_release' // fast release (not required): sent once the instant the controller lets go, so the owner falls back immediately instead of waiting for the heartbeat to expire
  // —— New device families (Opossum / Civet Edging / Paw Prints), see the kind field ——
  // The few new actions below only make sense for the Opossum vibration controller. They
  // do not reuse adjust_strength / burst / stop, because those three implicitly target
  // the Coyote (historical baggage) and overloading them would force every existing
  // consumer to add one more kind check; separate new actions are simpler instead, and
  // cost nothing in backward compatibility.
  | 'vibrate_adjust' // v=signed delta (same semantics as adjust_strength, but applied to Opossum intensity)
  | 'vibrate_stop' // stop Opossum vibration (c omitted = zero both channels)
  | 'vibrate_burst' // one-shot pulse: v=target strength, ms=duration (default 500ms), then falls back automatically
  // set_led is meaningful for paw-prints / civet-edging / opossum alike; kind tells them apart.
  | 'set_led';

export type PlayMode = 'single' | 'list' | 'random';

/**
 * Device command. `target` is carried by the topic (cmd/{peerId}), not by the payload.
 * All parameters are flattened to the top level to avoid a double JSON encode/decode.
 */
export interface DeviceCommand {
  action: CmdAction;
  /**
   * Target device kind. Omitted = the historical meaning "Coyote" (backward compatible
   * with the existing adjust_strength/change_wave/... actions, which never carry this
   * field). The vibrate_* family implicitly points at 'opossum', but still passes it
   * explicitly so the UI/logs do not have to infer it from the action name; set_led
   * must pass it explicitly, because the same member may have both a sensor and an
   * opossum connected and either one can set an LED.
   */
  kind?: DeviceKind;
  /** channel: 'A' | 'B' */
  c?: 'A' | 'B';
  /** numeric value: adjust_strength=delta; fire_active=boost; vibrate_adjust=delta; vibrate_burst=target strength; fire=absolute (deprecated) */
  v?: number;
  /** waveform id */
  w?: string;
  /** generic data: alert text, bg color */
  d?: string;
  /** queue: array of waveform ids (used by set_queue) */
  q?: string[];
  /** play mode (used by set_play_mode) */
  mode?: PlayMode;
  /** interval seconds (used by set_interval) */
  iv?: number;
  /** LED color enum 0-7 (used by set_led; the device protocol uses discrete color indices, not RGB / a continuous byte, see LedColorPicker). */
  color?: number;
  /** Duration in milliseconds, used by vibrate_burst; defaults to 500ms. */
  ms?: number;
}

export interface WaveformTransfer {
  /** waveform id */
  wid: string;
  /** waveform display name */
  wn: string;
  /** waveform frames [strength, frequency][] */
  fr: [number, number][];
}

export interface WaveformCatalogEntry {
  id: string;
  name: string;
  custom: boolean;
}

/** Sensor kind (paw-prints / civet-edging). A member has only one sensor connected at a time (v1 simplification). */
export type SensorKind = Extract<DeviceKind, 'paw-prints' | 'civet-edging'>;

/**
 * The complete MemberState (consumed by the UI).
 * On the wire it is split into two topics: fast (broadcast immediately on every change,
 * throttled to 200ms) and slow (a 5 second heartbeat as a backstop).
 */
export interface MemberState {
  peerId: string;
  displayName: string;
  deviceConnected: boolean;
  strengthA: number;
  strengthB: number;
  waveA: string | null;
  waveB: string | null;
  battery: number | null;
  waveformCatalog?: WaveformCatalogEntry[];
  // —— Added for queue sync ——
  queueA: string[];
  queueB: string[];
  playModeA: PlayMode;
  playModeB: PlayMode;
  intervalA: number;
  intervalB: number;
  currentIndexA: number;
  currentIndexB: number;
  // —— Added for firing state ——
  firingA: boolean;
  firingB: boolean;
  // —— Added for scene role-play ——
  /** The scene role id currently claimed (absent = no role claimed). */
  roleId?: string;
  /** Whether this is an AI-driven pseudo-member (peerId shaped like "ai:&lt;roleId&gt;"). */
  isAi?: boolean;
  /** Whether this member allows the room's AI to control their device (opt-in). */
  allowAi?: boolean;
  // —— Added for the Opossum (dual-channel vibration controller) ——
  opossumConnected?: boolean;
  opossumIntensityA?: number;
  opossumIntensityB?: number;
  opossumBattery?: number | null;
  // —— Added for sensors (Paw Prints / Civet Edging, one or the other) ——
  sensorKind?: SensorKind | null;
  sensorConnected?: boolean;
  sensorBattery?: number | null;
  /**
   * Human-readable summary of the most recent sensor reading + the raw value (if any) +
   * a timestamp. Used only for in-room display (for example "Alice 的爪印传感器：按钮已按下"),
   * **not** to auto-trigger any device action — see the corresponding TODO in
   * lib/commands.ts for why "sensor X triggers device Y" automation is left out this
   * time around.
   */
  sensorLastEvent?: string | null;
  sensorLastValue?: number | null;
  sensorLastEventAt?: number | null;
}

/** Scene role definition (= a title a member can claim). */
export interface SceneRole {
  id: string;
  name: string;
  /** Role description / persona: shown to members, and also used as the persona prompt when the role is handed to the AI. */
  description?: string;
  /** Whether this role can be played by the AI (flagged on Market upload; the host uses it to show the 「交给 AI」 entry point). */
  aiPlayable?: boolean;
}

/** Room scene: setting + roles + gameplay metadata. */
export interface Scene {
  id: string;
  name: string;
  setting: string;
  roles: SceneRole[];
  /** Suggested player count. */
  playerCount?: { min?: number; max?: number };
}

/** High-frequency fields: strength + current waveform id. Any change triggers an immediate broadcast. */
export interface StateFast {
  strengthA: number;
  strengthB: number;
  waveA: string | null;
  waveB: string | null;
  // —— Added for firing state ——
  firingA: boolean;
  firingB: boolean;
  // —— Opossum intensity (changes often, so it rides on fast) ——
  opossumIntensityA?: number;
  opossumIntensityB?: number;
  // —— Most recent sensor event (button press etc., also needs low latency) ——
  sensorLastEvent?: string | null;
  sensorLastValue?: number | null;
  sensorLastEventAt?: number | null;
}

/** Low-frequency fields: name, device connection, battery, waveform catalog. 5 second heartbeat. */
export interface StateSlow {
  displayName: string;
  deviceConnected: boolean;
  battery: number | null;
  waveformCatalog?: WaveformCatalogEntry[];
  // —— Added for queue sync ——
  queueA: string[];
  queueB: string[];
  playModeA: PlayMode;
  playModeB: PlayMode;
  intervalA: number;
  intervalB: number;
  currentIndexA: number;
  currentIndexB: number;
  /** Whether the room's AI roles may control this machine's device (opt-in; off by default). */
  allowAi?: boolean;
  // —— Opossum connection state / battery (low frequency) ——
  opossumConnected?: boolean;
  opossumBattery?: number | null;
  // —— Sensor connection state / kind / battery (low frequency) ——
  sensorKind?: SensorKind | null;
  sensorConnected?: boolean;
  sensorBattery?: number | null;
}
