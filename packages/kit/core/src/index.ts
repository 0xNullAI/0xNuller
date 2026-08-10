/**
 * @dg-kit/core — shared types and contract interfaces.
 *
 * Runtime-agnostic. Consumed by every other @dg-kit package and by the three
 * downstream apps (DG-Agent, DG-MCP, DG-Chat).
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export type Channel = 'A' | 'B';

/** A single 25 ms wave step: `[encodedFrequency, intensity]`. */
export type WaveFrame = [number, number];

export interface WaveformDefinition {
  id: string;
  name: string;
  description?: string;
  /** Sequence of 25 ms steps. */
  frames: WaveFrame[];
}

// ---------------------------------------------------------------------------
// Device state
// ---------------------------------------------------------------------------

export interface DeviceState {
  connected: boolean;
  deviceName?: string;
  address?: string;
  battery?: number;
  strengthA: number;
  strengthB: number;
  limitA: number;
  limitB: number;
  waveActiveA: boolean;
  waveActiveB: boolean;
  currentWaveA?: string;
  currentWaveB?: string;
}

export function createEmptyDeviceState(): DeviceState {
  return {
    connected: false,
    battery: 0,
    strengthA: 0,
    strengthB: 0,
    limitA: 200,
    limitB: 200,
    waveActiveA: false,
    waveActiveB: false,
  };
}

/**
 * Whether a Coyote is physically outputting on either channel.
 *
 * Strength is only the configured amplitude; without a running waveform no
 * pulses are emitted. The two signals must also belong to the same channel —
 * A strength plus a B waveform is still idle on both channels.
 */
export function isCoyoteOutputActive(
  state: Pick<DeviceState, 'strengthA' | 'strengthB' | 'waveActiveA' | 'waveActiveB'>,
): boolean {
  return (state.strengthA > 0 && state.waveActiveA) || (state.strengthB > 0 && state.waveActiveB);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type DeviceCommand =
  | {
      type: 'start';
      channel: Channel;
      strength: number;
      waveform: WaveformDefinition;
      loop: boolean;
    }
  | { type: 'stop'; channel?: Channel }
  | { type: 'adjustStrength'; channel: Channel; delta: number }
  | { type: 'changeWave'; channel: Channel; waveform: WaveformDefinition; loop: boolean }
  | { type: 'burst'; channel: Channel; strength: number; durationMs: number }
  | { type: 'emergencyStop' };

export interface TimerCommand {
  type: 'timer';
  seconds: number;
  label: string;
}

export interface DeviceCommandResult {
  state: DeviceState;
  notes?: string[];
}

// ---------------------------------------------------------------------------
// Tool plumbing
// ---------------------------------------------------------------------------

export interface ToolCall {
  id: string;
  name: string;
  displayName?: string;
  args: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  displayName?: string;
  description: string;
  /** JSON Schema for the tool parameters. */
  parameters: Record<string, unknown>;
}

/**
 * Named vibration-rhythm presets for the Opossum (see `@dg-kit/protocol`'s
 * `OPOSSUM_VIBRATION_PATTERNS` for the actual envelope data) — named here
 * rather than in `protocol` so `OpossumCommand` (a `core` type, since
 * `protocol` depends on `core` and not the reverse) can reference it
 * without a circular package dependency.
 */
export type OpossumVibrationPatternName = 'constant' | 'pulse' | 'wave' | 'ramp' | 'heartbeat';

/**
 * Commands for the Opossum vibrate controller. Separate from `DeviceCommand`
 * because Opossum's intensity model (0-200 direct set, no frequency/waveform
 * concept) doesn't fit the Coyote-shaped `DeviceCommand` union — forcing it
 * in would mean either lying about waveform/frequency fields or making them
 * optional everywhere, both worse than a small parallel type.
 */
export type OpossumCommand =
  | {
      type: 'vibrateStart';
      channel: Channel;
      intensity: number;
      /** Rhythm envelope to run at this intensity. Omitted = leave whichever pattern is already set (defaults to 'constant' on connect). */
      pattern?: OpossumVibrationPatternName;
    }
  | { type: 'vibrateStop'; channel?: Channel }
  | { type: 'vibrateAdjust'; channel: Channel; delta: number }
  /** Change a channel's rhythm envelope without touching its intensity — the vibrate counterpart of Coyote's changeWave. */
  | { type: 'vibrateSetPattern'; channel: Channel; pattern: OpossumVibrationPatternName }
  /** Briefly raise a channel to `intensity` for `durationMs`, then auto-restore — the vibrate counterpart of Coyote's burst. */
  | { type: 'vibrateBurst'; channel: Channel; intensity: number; durationMs: number };

export type ToolExecutionPlan =
  | { type: 'device'; command: DeviceCommand }
  | { type: 'timer'; command: TimerCommand }
  | { type: 'opossum'; command: OpossumCommand }
  | { type: 'setIndicatorColor'; deviceKind: DeviceKind; color: number }
  | { type: 'inline'; output: string; summary?: string };

export function isDeviceToolName(name: string): boolean {
  return (
    name === 'shock_start' ||
    name === 'shock_stop' ||
    name === 'shock_adjust' ||
    name === 'shock_change_wave' ||
    name === 'shock_burst' ||
    // Pre-1.9.0 Coyote tool names — still resolvable via ToolRegistry
    // aliases, so calls arriving under them must still count as device
    // tools (connection gating, permission flow) too.
    name === 'start' ||
    name === 'stop' ||
    name === 'adjust_strength' ||
    name === 'change_wave' ||
    name === 'burst' ||
    name === 'vibrate_start' ||
    name === 'vibrate_stop' ||
    name === 'vibrate_adjust' ||
    name === 'vibrate_change_pattern' ||
    name === 'vibrate_burst' ||
    name === 'set_indicator_color'
  );
}

// ---------------------------------------------------------------------------
// Contract interfaces
// ---------------------------------------------------------------------------

export interface DeviceClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getState(): Promise<DeviceState>;
  execute(command: DeviceCommand): Promise<DeviceCommandResult>;
  emergencyStop(): Promise<void>;
  onStateChanged(listener: (state: DeviceState) => void): () => void;
}

export interface WaveformLibrary {
  getById(id: string): Promise<WaveformDefinition | null>;
  list(): Promise<WaveformDefinition[]>;
  /**
   * Persist a new or updated waveform. Optional because not every library
   * implementation supports writing (e.g. a read-only Node bundle); design
   * tools should branch on its presence.
   */
  save?(waveform: WaveformDefinition): Promise<void>;
}

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Multi-device kind support
// ---------------------------------------------------------------------------

/** Every DG-Lab BLE device family this runtime knows how to talk to. */
export type DeviceKind = 'coyote' | 'paw-prints' | 'civet-edging' | 'opossum';

/**
 * Sensor devices (paw-prints, civet-edging) push event/telemetry streams
 * rather than exposing a two-channel strength+waveform state. They get a
 * narrower contract instead of being forced into the stim-shaped
 * `DeviceState`/`DeviceCommand` types, which stay Coyote-only.
 */
export interface SensorState {
  connected: boolean;
  deviceName?: string;
  address?: string;
  battery?: number;
}

/** Chinese display name for each device kind, used in user-facing denial/guidance text. */
export const DEVICE_KIND_DISPLAY_NAME: Record<DeviceKind, string> = {
  coyote: '郊狼',
  'paw-prints': '爪印',
  'civet-edging': '灵猫',
  opossum: '负鼠',
};

/**
 * Contract for sensor-family clients (paw-prints, civet-edging): read-only
 * event streams plus an optional LED setter (civet-edging's indicator color
 * is set via the same packet as its pressure-reporting toggle; paw-prints
 * has a dedicated LED command — both satisfy this optional method).
 *
 * Runtime-level contract, not a concrete implementation — actual Web
 * Bluetooth/Tauri-backed instances live in the transport packages.
 */
export interface SensorDeviceClient<TReading> {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getState(): Promise<SensorState>;
  subscribe(listener: (reading: TReading) => void): () => void;
  onStateChanged(listener: (state: SensorState) => void): () => void;
  setIndicatorColor?(color: number): Promise<void>;
}

export function createEmptySensorState(): SensorState {
  return { connected: false, battery: 0 };
}

/**
 * The message the Tauri BLE transport throws when the user backs out of the
 * device picker.
 *
 * Exported so the check and the throw cannot drift: the transport raises it,
 * and every module tests for it. They diverged once — Voice matched
 * `/cancelled|user gesture/i`, which never matches this Chinese text, and
 * Chat had no check at all. On Android, where this transport is the only one
 * available, backing out of the picker therefore raised a red error banner in
 * both. That is a bug the user cannot distinguish from a real failure, and
 * Android has no hot update.
 */
export const DEVICE_PICKER_CANCELLED_MESSAGE = '用户取消了设备选择';

/** What Web Bluetooth throws for the same thing. */
const WEB_BLUETOOTH_CANCELLED_MESSAGE = 'User cancelled the requestDevice() chooser';

/**
 * Whether an error is "the user closed the device picker" rather than a
 * failure.
 *
 * It is a normal action and must not surface as an error: the browser and
 * the Tauri transport just report it by throwing.
 */
export function isDevicePickerCancelled(error: unknown): boolean {
  const raw =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : String(error ?? '');
  const message = raw.trim().replace(/^(DOMException|TypeError|Error|AbortError):\s*/i, '');
  return (
    message.includes(WEB_BLUETOOTH_CANCELLED_MESSAGE) ||
    message.includes(DEVICE_PICKER_CANCELLED_MESSAGE)
  );
}
