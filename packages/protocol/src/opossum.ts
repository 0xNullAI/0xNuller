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
 * Android side note from the doc: MTU should be negotiated up to 144 for
 * this device family. That's a transport-layer concern (the caller's BLE
 * connect step), out of scope here — this file only builds/parses packets.
 */
import type { WebBluetoothConnectionContext } from './base.js';
import {
  V3_BATTERY_CHAR,
  V3_BATTERY_SERVICE,
  V3_NOTIFY_CHAR,
  V3_PRIMARY_SERVICE,
  V3_WRITE_CHAR,
} from './constants.js';
import type { BluetoothRemoteGATTCharacteristicLike } from './types.js';

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

type OpossumStateListener = (state: OpossumState) => void;
type OpossumButtonListener = (event: OpossumButtonEvent) => void;

export class OpossumVibrateAdapter {
  private state: OpossumState = createEmptyOpossumState();
  private writeChar: BluetoothRemoteGATTCharacteristicLike | null = null;
  private notifyChar: BluetoothRemoteGATTCharacteristicLike | null = null;
  private batteryChar: BluetoothRemoteGATTCharacteristicLike | null = null;

  private readonly stateListeners = new Set<OpossumStateListener>();
  private readonly buttonListeners = new Set<OpossumButtonListener>();

  async onConnected(context: WebBluetoothConnectionContext): Promise<void> {
    try {
      const primaryService = await context.server.getPrimaryService(V3_PRIMARY_SERVICE);
      this.writeChar = await primaryService.getCharacteristic(V3_WRITE_CHAR);
      this.notifyChar = await primaryService.getCharacteristic(V3_NOTIFY_CHAR);
      await this.notifyChar.startNotifications();
      this.notifyChar.addEventListener('characteristicvaluechanged', this.handleNotification);

      let battery = 0;
      try {
        const batteryService = await context.server.getPrimaryService(V3_BATTERY_SERVICE);
        this.batteryChar = await batteryService.getCharacteristic(V3_BATTERY_CHAR);
        const value = await this.batteryChar.readValue();
        battery = value.getUint8(0);
      } catch {
        // Best-effort: some units don't expose (or fail to read) battery.
        this.batteryChar = null;
        battery = 0;
      }

      this.state = {
        connected: true,
        deviceName: context.device.name ?? '',
        address: context.device.id ?? '',
        battery,
        intensityA: 0,
        intensityB: 0,
      };
      this.emitState();
    } catch (error) {
      this.writeChar = null;
      this.notifyChar = null;
      this.batteryChar = null;
      throw error;
    }
  }

  async onDisconnected(): Promise<void> {
    if (this.notifyChar) {
      this.notifyChar.removeEventListener('characteristicvaluechanged', this.handleNotification);
      try {
        await this.notifyChar.stopNotifications();
      } catch {
        // ignore best effort
      }
    }

    this.writeChar = null;
    this.notifyChar = null;
    this.batteryChar = null;
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
   * channel as-is (mapped to the 0xFF sentinel byte).
   */
  async setIntensity(
    channelA: number | 'unchanged',
    channelB: number | 'unchanged',
  ): Promise<void> {
    const byteA = channelA === 'unchanged' ? 0xff : this.clamp(channelA, 0, 200);
    const byteB = channelB === 'unchanged' ? 0xff : this.clamp(channelB, 0, 200);

    const packet = new Uint8Array([0xb3, byteA, byteB]);
    await this.write(packet);

    if (channelA !== 'unchanged') this.state.intensityA = byteA;
    if (channelB !== 'unchanged') this.state.intensityB = byteB;
    this.emitState();
  }

  /**
   * 0xB0 vibration waveform. This is a single packet builder/writer — the
   * device expects it re-sent (~every 100ms) by the CALLER to sustain a
   * waveform effect, but that re-send loop is the caller's responsibility;
   * this device doesn't need (and this adapter doesn't run) a tick loop
   * the way Coyote does, since 0xB3 is a direct "set now" command.
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
      this.clamp(color, 0, 255),
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
    try {
      await this.setIntensity(0, 0);
    } catch {
      // ignore best effort
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
    await this.writeCharacteristicValue(this.writeChar, packet);
  }

  /**
   * Same fallback-chain pattern as `BaseCoyoteProtocolAdapter.writeCharacteristicValue`
   * in ./base.ts, reimplemented here since that method is protected on a
   * class this adapter doesn't (and shouldn't) extend.
   */
  private async writeCharacteristicValue(
    characteristic: BluetoothRemoteGATTCharacteristicLike,
    value: ArrayBufferView | ArrayBuffer,
  ): Promise<void> {
    const attempts = [
      characteristic.writeValueWithoutResponse?.bind(characteristic),
      characteristic.writeValueWithResponse?.bind(characteristic),
      characteristic.writeValue?.bind(characteristic),
    ];

    let lastError: unknown = null;
    for (const attempt of attempts) {
      if (!attempt) continue;
      try {
        await attempt(value);
        return;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError ?? new Error('Bluetooth characteristic is not writable');
  }

  private clamp(value: number, min: number, max: number): number {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.max(min, Math.min(max, Math.round(number)));
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
