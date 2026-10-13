import type { DeviceKind, OpossumVibrationPatternName, PlayMode } from '@dg-kit/core';
import type { CmdAction, DeviceCommand, WaveformTransfer } from './protocol';

/**
 * Turn a command frame from another member into a DeviceCommand, or null.
 *
 * Every field is checked for type and range before it can reach the device: a string where a
 * number belongs used to be concatenated into the strength ("5" + 5 → straight to the limit), and
 * a zero interval rotated waveforms every few milliseconds, flooding Bluetooth and starving the
 * page that holds the stop button. A field with the wrong type is dropped; the handler then
 * refuses the command as incomplete. The holder's limits still clamp everything that passes.
 */

const ACTIONS: readonly CmdAction[] = [
  'adjust_strength',
  'change_wave',
  'start',
  'stop',
  'stop_wave',
  'burst',
  'vibrate',
  'alert',
  'bg',
  'shake',
  'beep',
  'set_queue',
  'set_play_mode',
  'set_interval',
  'fire_active',
  'fire_release',
  'vibrate_adjust',
  'vibrate_stop',
  'vibrate_change_pattern',
  'vibrate_burst',
  'set_led',
];
const KINDS: readonly DeviceKind[] = ['coyote', 'paw-prints', 'civet-edging', 'opossum'];
const MODES: readonly PlayMode[] = ['single', 'list', 'random'];
const PATTERNS: readonly OpossumVibrationPatternName[] = [
  'constant',
  'pulse',
  'wave',
  'ramp',
  'heartbeat',
];
/** The largest increase one command may make; the holder clamps to its limit after. */
export const MAX_REMOTE_STEP = 50;

function int(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : undefined;
}

function str(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length <= max ? value : undefined;
}

export function parseRemoteCommand(data: Record<string, unknown>): DeviceCommand | null {
  const action = data.a as CmdAction;
  if (!ACTIONS.includes(action)) return null;
  const step =
    action === 'adjust_strength' || action === 'vibrate_adjust'
      ? // Lowering output is never limited; raising it is, per command.
        int(data.v, -200, MAX_REMOTE_STEP)
      : int(data.v, 0, 200);
  const queue = Array.isArray(data.q)
    ? data.q.filter((id): id is string => typeof id === 'string' && id.length <= 128).slice(0, 100)
    : undefined;
  const command: DeviceCommand = { action };
  const c = data.c === 'A' || data.c === 'B' ? data.c : undefined;
  const kind = KINDS.includes(data.kind as DeviceKind) ? (data.kind as DeviceKind) : undefined;
  const fields: Partial<DeviceCommand> = {
    kind,
    deviceId: str(data.deviceId, 256),
    c,
    v: step,
    w: str(data.w, 128),
    d: str(data.d, 500),
    q: queue,
    mode: MODES.includes(data.mode as PlayMode) ? (data.mode as PlayMode) : undefined,
    iv: int(data.iv, 5, 3600),
    color: int(data.color, 0, 7),
    ms: int(data.ms, 50, 5000),
    pattern: PATTERNS.includes(data.pattern as OpossumVibrationPatternName)
      ? (data.pattern as OpossumVibrationPatternName)
      : undefined,
  };
  for (const [key, value] of Object.entries(fields))
    if (value !== undefined) (command as unknown as Record<string, unknown>)[key] = value;
  return command;
}

/** Longest waveform another member may send: a few minutes of 100 ms frames. */
const MAX_WAVE_FRAMES = 3000;

/** A shared waveform, or null unless every frame is a pair of in-range integers. */
export function parseWaveformTransfer(data: Record<string, unknown>): WaveformTransfer | null {
  if (
    typeof data.wid !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(data.wid) ||
    typeof data.wn !== 'string' ||
    !data.wn.trim() ||
    !Array.isArray(data.fr) ||
    data.fr.length === 0 ||
    data.fr.length > MAX_WAVE_FRAMES
  )
    return null;
  const frames: [number, number][] = [];
  for (const frame of data.fr) {
    if (
      !Array.isArray(frame) ||
      frame.length !== 2 ||
      !frame.every((value) => Number.isInteger(value) && value >= 0 && value <= 1000)
    )
      return null;
    frames.push([frame[0] as number, frame[1] as number]);
  }
  return {
    wid: data.wid,
    wn: data.wn.trim().slice(0, 60),
    fr: frames,
    modality: data.mo === 'vibration' ? 'vibration' : 'electrostimulation',
  };
}
