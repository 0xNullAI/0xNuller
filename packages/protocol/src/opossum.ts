/**
 * Opossum Vibrate Controller (负鼠振动控制器) protocol adapter.
 *
 * Unlike Coyote (stim, strength+waveform) or the paw-prints/civet-edging
 * sensors (pure telemetry), this is a dual-channel vibration device that
 * both accepts intensity commands (output) AND reports physical button
 * presses (input). It doesn't fit `WebBluetoothProtocolAdapter` (that
 * interface's `DeviceCommand`/`DeviceState` are Coyote-strength-shaped with
 * frequency/waveform concepts this device has no notion of) or
 * `WebBluetoothSensorAdapter` (this device isn't pure-sensor), so it gets
 * its own standalone public API instead.
 *
 * GATT skeleton is identical to Coyote V3 (service 0x180C, write 0x150A,
 * notify 0x150B, battery 0x180A/0x1500) — only the opcodes differ.
 *
 * Assumption: the community protocol doc's marketing name "Opossum
 * Vibration Controller 47L127000" suggests a product-name-prefixed BLE
 * name, but every sibling 47L12x-family device advertises a bare
 * `47L1XX000`-style model string with no product-name prefix, so the
 * advertised BLE name is assumed to be just `47L127000`
 * (`OPOSSUM_DEVICE_NAME_PREFIX`), not literally starting with "Opossum".
 *
 * ## Why intensity alone never made the motor spin (fixed here)
 *
 * The doc's B3 command only sets a *displayed* "channel strength" (0-200,
 * same scale as Coyote's strength) — the actual motor drive comes from B0,
 * a 20-byte packet carrying 4×25ms amplitude samples (0-100) per channel
 * that **must be re-sent every 100ms** to keep vibrating; the moment the
 * stream stops, so does the motor. `setIntensity`/`vibrate_start` used to
 * write B3 once and never touch B0 at all — the device updated its
 * strength *state* but the motor never actually received a waveform to
 * play. This adapter now drives an internal 100ms `ProtocolTickLoop`
 * (started/stopped by `setIntensity`/`adjustIntensity`/`emergencyStop`
 * whenever either channel's intensity crosses 0) that streams `writeWaveformFrame()`
 * itself — `vibrate_start`'s external contract (fire-and-forget, no caller
 * tick loop) is unchanged, it just actually works now.
 */
import type { Channel, OpossumVibrationPatternName } from '@dg-kit/core';
import type { WebBluetoothConnectionContext } from './base.js';
import {
  clampIndicatorColor,
  clampNumber,
  connectSensorGatt,
  disconnectSensorGatt,
  writeCharacteristicValue,
} from './gatt-utils.js';
import { ProtocolTickLoop } from './tick-loop.js';
import type { BluetoothRemoteGATTCharacteristicLike } from './types.js';
import { WaveCursor, type WaveCursorState, createEmptyWaveCursorState } from './wave-cursor.js';

export interface OpossumState {
  connected: boolean;
  deviceName?: string;
  address?: string;
  battery?: number;
  intensityA: number;
  intensityB: number;
}

export function createEmptyOpossumState(): OpossumState {
  return { connected: false, battery: 0, intensityA: 0, intensityB: 0 };
}

export type OpossumButton =
  | 'SEL_1'
  | 'SEL_2'
  | 'HOME'
  | 'Up'
  | 'Down'
  | 'Left'
  | 'Right'
  | 'B'
  | 'A'
  | 'G'
  | 'D';

export interface OpossumButtonEvent {
  sequence: number;
  pressed: Set<OpossumButton>;
}

/** Bit position (in the little-endian 16-bit bitmap) for each named button. */
const BUTTON_BITS: ReadonlyArray<readonly [OpossumButton, number]> = [
  ['SEL_1', 0],
  ['SEL_2', 1],
  ['HOME', 2],
  ['Up', 8],
  ['Down', 9],
  ['Left', 10],
  ['Right', 11],
  ['B', 12],
  ['A', 13],
  ['G', 14],
  ['D', 15],
];

/**
 * Named vibration-rhythm envelopes, each element a 0-100 amplitude sample
 * covering 25ms (so a 40-element pattern spans one second), looped forever
 * while a channel is running. Each B0 tick's actual byte is this envelope
 * value scaled by the channel's current intensity (0-200 → 0-100 ceiling),
 * so `pattern` (rhythm/shape) and `intensity` (how strong) compose
 * independently — switching pattern doesn't change perceived peak strength.
 * Kept as named presets rather than letting the LLM submit an arbitrary
 * array: an LLM-generated envelope has no guardrail against e.g. a rapid
 * 0↔100 alternation that reads as "intense" in the abstract but is
 * unpleasant/startling on real skin.
 */
export const OPOSSUM_VIBRATION_PATTERNS: Record<OpossumVibrationPatternName, readonly number[]> = {
  constant: [100],
  pulse: [...Array(20).fill(100), ...Array(20).fill(0)],
  wave: Array.from({ length: 40 }, (_, i) =>
    Math.round(50 + 50 * Math.sin((i / 40) * 2 * Math.PI)),
  ),
  ramp: Array.from({ length: 40 }, (_, i) => Math.round(((i + 1) / 40) * 100)),
  heartbeat: [
    ...Array(6).fill(100),
    ...Array(6).fill(0),
    ...Array(6).fill(80),
    ...Array(30).fill(0),
  ],
};

type OpossumStateListener = (state: OpossumState) => void;
type OpossumButtonListener = (event: OpossumButtonEvent) => void;

export class OpossumVibrateAdapter {
  private state: OpossumState = createEmptyOpossumState();
  private writeChar: BluetoothRemoteGATTCharacteristicLike | null = null;
  private notifyChar: BluetoothRemoteGATTCharacteristicLike | null = null;

  private readonly stateListeners = new Set<OpossumStateListener>();
  private readonly buttonListeners = new Set<OpossumButtonListener>();

  private readonly tickLoop = new ProtocolTickLoop();
  private readonly patternCursor = new WaveCursor<number, number>((frame) =>
    clampNumber(frame, 0, 100),
  );
  private readonly patterns: Record<Channel, readonly number[]> = {
    A: OPOSSUM_VIBRATION_PATTERNS.constant,
    B: OPOSSUM_VIBRATION_PATTERNS.constant,
  };
  private readonly patternState: Record<Channel, WaveCursorState<number>> = {
    A: createEmptyWaveCursorState<number>(),
    B: createEmptyWaveCursorState<number>(),
  };
  private readonly burstRestores = new Map<Channel, ReturnType<typeof setTimeout>>();

  async onConnected(context: WebBluetoothConnectionContext): Promise<void> {
    try {
      const connection = await connectSensorGatt(context, this.handleNotification);
      this.writeChar = connection.writeChar;
      this.notifyChar = connection.notifyChar;

      this.state = {
        connected: true,
        deviceName: connection.deviceName,
        address: connection.address,
        battery: connection.battery,
        intensityA: 0,
        intensityB: 0,
      };
      this.patterns.A = OPOSSUM_VIBRATION_PATTERNS.constant;
      this.patterns.B = OPOSSUM_VIBRATION_PATTERNS.constant;
      this.patternState.A = createEmptyWaveCursorState<number>();
      this.patternState.B = createEmptyWaveCursorState<number>();
      this.emitState();

      // Connect-time handshake writes an LED-color+button-reporting packet
      // that defaults button reporting OFF — without this, D0 (button)
      // notifications never arrive at all.
      await this.setLed(0x01, true);
    } catch (error) {
      // Tear down the same way onDisconnected() does — if startNotifications()
      // and addEventListener() above already succeeded before a later step
      // threw (e.g. the handshake or battery read), leaving the subscription
      // live here would leak it silently, since nothing else will ever call
      // stopNotifications()/removeEventListener() for this failed attempt.
      await this.onDisconnected();
      throw error;
    }
  }

  async onDisconnected(): Promise<void> {
    this.cancelBurstRestore('A');
    this.cancelBurstRestore('B');
    this.tickLoop.stop();
    await this.tickLoop.waitForIdle();
    await disconnectSensorGatt(this.notifyChar, this.handleNotification);

    this.writeChar = null;
    this.notifyChar = null;
    this.patterns.A = OPOSSUM_VIBRATION_PATTERNS.constant;
    this.patterns.B = OPOSSUM_VIBRATION_PATTERNS.constant;
    this.patternState.A = createEmptyWaveCursorState<number>();
    this.patternState.B = createEmptyWaveCursorState<number>();
    this.state = createEmptyOpossumState();
    this.emitState();
  }

  getState(): OpossumState {
    return { ...this.state };
  }

  subscribeButtons(listener: OpossumButtonListener): () => void {
    this.buttonListeners.add(listener);
    return () => {
      this.buttonListeners.delete(listener);
    };
  }

  onStateChanged(listener: OpossumStateListener): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  /**
   * 0xB3 direct intensity: A/B in 0-200, or 'unchanged' to leave that
   * channel as-is (mapped to the 0xFF sentinel byte). Starts/stops the
   * internal B0 tick loop so the motor actually follows — see the file
   * doc comment for why that's necessary.
   */
  async setIntensity(
    channelA: number | 'unchanged',
    channelB: number | 'unchanged',
  ): Promise<void> {
    const byteA = channelA === 'unchanged' ? 0xff : this.clamp(channelA, 0, 200);
    const byteB = channelB === 'unchanged' ? 0xff : this.clamp(channelB, 0, 200);

    const packet = new Uint8Array([0xb3, byteA, byteB]);
    await this.write(packet);

    if (channelA !== 'unchanged') this.applyIntensity('A', byteA);
    if (channelB !== 'unchanged') this.applyIntensity('B', byteB);
    this.emitState();

    await this.syncTickLoop();
    await this.updateDisplay(this.state.intensityA, this.state.intensityB).catch(() => undefined);
  }

  /**
   * Relative adjust for one channel, e.g. for a `vibrate_adjust` tool call.
   * Reads the current intensity and writes the new absolute value in one
   * call so a caller never has to do `getState()` + `setIntensity()` as two
   * separate steps — doing it as two steps would let two concurrent adjust
   * calls (an LLM tool call racing a manual UI tweak, say) both read the
   * same stale value and the second write silently clobber the first's
   * delta instead of compounding.
   */
  async adjustIntensity(channel: Channel, delta: number): Promise<void> {
    const current = channel === 'A' ? this.state.intensityA : this.state.intensityB;
    const next = this.clamp(current + delta, 0, 200);
    if (channel === 'A') {
      await this.setIntensity(next, 'unchanged');
    } else {
      await this.setIntensity('unchanged', next);
    }
  }

  /**
   * Briefly drive one channel to `intensity`, then restore it after
   * `durationMs` — the vibrate counterpart of Coyote's `runBurst`, with the
   * identical stale-restore guard: the restore target is
   * `min(current, previous)`, so an intervening stop or manual decrease is
   * never pushed back *up* by a late-firing restore timer.
   */
  async vibrateBurst(channel: Channel, intensity: number, durationMs: number): Promise<void> {
    this.cancelBurstRestore(channel);
    const previous = channel === 'A' ? this.state.intensityA : this.state.intensityB;

    if (channel === 'A') {
      await this.setIntensity(intensity, 'unchanged');
    } else {
      await this.setIntensity('unchanged', intensity);
    }

    const timer = setTimeout(
      () => {
        this.burstRestores.delete(channel);
        const current = channel === 'A' ? this.state.intensityA : this.state.intensityB;
        const target = Math.min(current, previous);
        const restore =
          channel === 'A'
            ? this.setIntensity(target, 'unchanged')
            : this.setIntensity('unchanged', target);
        // Best-effort: the device may have disconnected while the timer was
        // pending; a failed restore write must not surface as an unhandled
        // rejection.
        void restore.catch(() => undefined);
      },
      Math.max(100, durationMs),
    );

    this.burstRestores.set(channel, timer);
  }

  private cancelBurstRestore(channel: Channel): void {
    const timer = this.burstRestores.get(channel);
    if (timer) {
      clearTimeout(timer);
      this.burstRestores.delete(channel);
    }
  }

  /**
   * Sets which named rhythm envelope a channel's B0 stream follows (see
   * `OPOSSUM_VIBRATION_PATTERNS`). If the channel is currently running
   * (intensity > 0), the new pattern takes over from its own beginning on
   * the next tick — changing rhythm restarts the phase rather than
   * splicing into wherever the old pattern's cursor happened to be, so the
   * new rhythm is predictable. Does not touch intensity.
   */
  setVibrationPattern(channel: Channel, pattern: readonly number[]): void {
    this.patterns[channel] = pattern.length > 0 ? pattern : OPOSSUM_VIBRATION_PATTERNS.constant;
    const running = (channel === 'A' ? this.state.intensityA : this.state.intensityB) > 0;
    if (running) {
      this.resetPatternCursor(channel);
    }
  }

  /**
   * 0xB0 vibration waveform. This is a single packet builder/writer — the
   * device expects it re-sent (~every 100ms) to sustain a waveform effect.
   * `setIntensity`/`adjustIntensity`/`emergencyStop` already drive this
   * automatically via an internal tick loop; call this directly only for
   * advanced one-off frames, and never concurrently with a running channel
   * (intensity > 0) or writes will interleave/race with the internal loop.
   */
  async writeWaveformFrame(
    channelA: [number, number, number, number],
    channelB: [number, number, number, number],
  ): Promise<void> {
    const packet = new Uint8Array(20);
    packet[0] = 0xb0;
    // bytes 1-7 are reserved/zero
    for (let i = 0; i < 4; i++) {
      // Doc doesn't fully specify "invalidates" semantics for >100 bytes;
      // clamping to 100 is the conservative reading rather than wrapping.
      packet[8 + i] = this.clamp(channelA[i] ?? 0, 0, 100);
      packet[16 + i] = this.clamp(channelB[i] ?? 0, 0, 100);
    }
    // bytes 12-15 are reserved/zero
    await this.write(packet);
  }

  /** 0x50 LED color + button-state-reporting toggle. */
  async setLed(color: number, enableButtonReporting: boolean): Promise<void> {
    const packet = new Uint8Array([
      0x50,
      clampIndicatorColor(color),
      enableButtonReporting ? 0x01 : 0x00,
    ]);
    await this.write(packet);
  }

  /**
   * 0xB2 screen display update: fixed 21-byte preamble + current A/B
   * intensity. The source doc's summary states "23 bytes" total but also
   * enumerates exactly 21 fixed preamble bytes; 1 (opcode) + 21 + 2 (A/B)
   * is actually 24. Trusting the literal, unambiguous byte enumeration over
   * the (likely miscounted) total-length label.
   *
   * The doc states the on-device screen only updates when the host
   * actively pushes this after a B3 change — `setIntensity()` and the B3
   * notification handler both call this so the screen and our own state
   * never drift apart regardless of which side initiated the change.
   */
  async updateDisplay(channelA: number, channelB: number): Promise<void> {
    const preamble = [
      0xff, 0xff, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
      0xff, 0xff, 0xff, 0xff, 0x08, 0x09,
    ];
    const packet = new Uint8Array([
      0xb2,
      ...preamble,
      this.clamp(channelA, 0, 200),
      this.clamp(channelB, 0, 200),
    ]);
    await this.write(packet);
  }

  /** Best-effort safety call: drive both channels to zero, ignore failures. */
  async emergencyStop(): Promise<void> {
    // A pending burst restore firing after the stop would re-raise the
    // channel to its pre-burst intensity — cancel first, same as Coyote.
    this.cancelBurstRestore('A');
    this.cancelBurstRestore('B');
    try {
      await this.setIntensity(0, 0);
    } catch {
      // ignore best effort
    }
  }

  private applyIntensity(channel: Channel, next: number): void {
    const wasStopped = (channel === 'A' ? this.state.intensityA : this.state.intensityB) <= 0;
    if (channel === 'A') {
      this.state.intensityA = next;
    } else {
      this.state.intensityB = next;
    }
    // Only a genuine stopped→running transition restarts the pattern phase
    // — an adjustIntensity() call while already running must not stutter
    // the rhythm back to its start on every small step.
    if (wasStopped && next > 0) {
      this.resetPatternCursor(channel);
    }
  }

  private resetPatternCursor(channel: Channel): void {
    this.patternState[channel] = {
      frames: [...this.patterns[channel]],
      index: 0,
      loop: true,
      active: true,
    };
  }

  private buildQuad(channel: Channel): [number, number, number, number] {
    const intensity = channel === 'A' ? this.state.intensityA : this.state.intensityB;
    if (intensity <= 0) return [0, 0, 0, 0];

    // Intensity (0-200, same scale as Coyote strength) becomes the B0
    // ceiling (0-100); the pattern's 0-100 envelope value is a percentage
    // of that ceiling, so pattern and intensity compose independently.
    const ceiling = intensity / 2;
    const state = this.patternState[channel];
    const quad: number[] = [];
    for (let i = 0; i < 4; i++) {
      const envelope = this.patternCursor.advanceStep(state) ?? 0;
      quad.push(clampNumber((envelope / 100) * ceiling, 0, 100));
    }
    return quad as [number, number, number, number];
  }

  private async performTick(): Promise<void> {
    if (!this.writeChar) return;
    await this.writeWaveformFrame(this.buildQuad('A'), this.buildQuad('B'));
  }

  /**
   * Starts the B0 tick loop the moment either channel has intensity > 0,
   * stops it (and writes one final explicit all-zero B0 frame — the same
   * "don't just cease ticking, say stop" principle as Coyote's
   * `emergencyStop`) once both channels are back at 0.
   */
  private async syncTickLoop(): Promise<void> {
    const shouldRun = this.state.intensityA > 0 || this.state.intensityB > 0;
    if (shouldRun) {
      this.tickLoop.start(() => this.performTick());
      return;
    }
    this.tickLoop.stop();
    await this.tickLoop.waitForIdle();
    if (this.writeChar) {
      await this.writeWaveformFrame([0, 0, 0, 0], [0, 0, 0, 0]).catch(() => undefined);
    }
  }

  private readonly handleNotification = (event: Event): void => {
    const target = event.target as BluetoothRemoteGATTCharacteristicLike | null;
    const value = target?.value;
    if (!value || value.byteLength < 1) return;

    const opcode = value.getUint8(0);
    if (opcode === 0xb3 && value.byteLength >= 3) {
      this.state.intensityA = value.getUint8(1);
      this.state.intensityB = value.getUint8(2);
      this.emitState();
      void this.syncTickLoop();
      void this.updateDisplay(this.state.intensityA, this.state.intensityB).catch(() => undefined);
      return;
    }

    if (opcode === 0xd0 && value.byteLength >= 4) {
      const sequence = value.getUint8(1);
      const bitmap = value.getUint8(2) | (value.getUint8(3) << 8);
      const pressed = new Set<OpossumButton>();
      for (const [button, bit] of BUTTON_BITS) {
        if ((bitmap & (1 << bit)) !== 0) {
          pressed.add(button);
        }
      }
      this.emitButtonEvent({ sequence, pressed });
    }
  };

  private async write(packet: Uint8Array): Promise<void> {
    if (!this.writeChar) {
      throw new Error('Opossum device is not connected');
    }
    await writeCharacteristicValue(this.writeChar, packet);
  }

  private clamp(value: number, min: number, max: number): number {
    return clampNumber(value, min, max);
  }

  private emitState(): void {
    const snapshot = this.getState();
    for (const listener of this.stateListeners) {
      listener(snapshot);
    }
  }

  private emitButtonEvent(event: OpossumButtonEvent): void {
    for (const listener of this.buttonListeners) {
      listener(event);
    }
  }
}
