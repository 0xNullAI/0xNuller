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
  | { type: 'vibrateAdjust'; channel: Channel; delta: number };

export type ToolExecutionPlan =
  | { type: 'device'; command: DeviceCommand }
  | { type: 'timer'; command: TimerCommand }
  | { type: 'opossum'; command: OpossumCommand }
  | { type: 'setIndicatorColor'; deviceKind: DeviceKind; color: number }
  | { type: 'inline'; output: string; summary?: string };

export function isDeviceToolName(name: string): boolean {
  return (
    name === 'start' ||
    name === 'stop' ||
    name === 'adjust_strength' ||
    name === 'change_wave' ||
    name === 'burst' ||
    name === 'vibrate_start' ||
    name === 'vibrate_stop' ||
    name === 'vibrate_adjust' ||
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

export function createEmptySensorState(): SensorState {
  return { connected: false, battery: 0 };
}
