/**
 * Protocol adapter for the "Paw-Prints" (爪印) wireless button/motion sensor.
 *
 * Shares the exact GATT skeleton with Coyote V3 (service 0x180C, write
 * 0x150A, notify 0x150B, battery 0x180A/0x1500) — only the application-layer
 * opcodes differ, so the transport wiring below mirrors `v3.ts` but the
 * command/notification framing is Paw-Prints-specific.
 *
 * NOTE: the byte layout below is transcribed from a paraphrased summary of
 * the community protocol doc, not a byte-exact spec or a real device
 * capture. Fields called out with a comment are best-effort interpretations
 * that need confirming against real hardware before being treated as
 * authoritative.
 */
import { createEmptySensorState, type SensorState } from '@dg-kit/core';
import type { WebBluetoothConnectionContext, WebBluetoothSensorAdapter } from './base.js';
import {
  clampIndicatorColor,
  connectSensorGatt,
  disconnectSensorGatt,
  writeCharacteristicValue,
} from './gatt-utils.js';
import type { BluetoothRemoteGATTCharacteristicLike } from './types.js';

export type PawPrintsReading =
  | { type: 'status'; color: number; deviceType: number; battery: number }
  | { type: 'trigger'; eventId: number; parameterValue: number }
  | { type: 'triggerCancel'; eventId: number }
  | { type: 'parameterChange'; eventId: number; value: number }
  | {
      type: 'physical';
      sequence: number;
      pressState: number;
      acceleration: number;
      angleX: number;
      angleY: number;
      angleZ: number;
      extVoltage: number;
    }
  | {
      type: 'autoDetectResult';
      xRange: [number, number];
      yRange: [number, number];
      zRange: [number, number];
    };

export type PawPrintsReadingListener = (reading: PawPrintsReading) => void;
export type PawPrintsStateListener = (state: SensorState) => void;

// Outbound command opcodes.
const CMD_CONFIGURE_TRIGGER = 0x50;
const CMD_RESET_PARAMETERS = 0x5f;
const CMD_START_ANGLE_DETECTION = 0x60;
const CMD_LED_CONTROL = 0x70;

// Inbound notification opcodes.
const NOTIFY_STATUS = 0x51;
const NOTIFY_TRIGGER = 0x5a;
const NOTIFY_TRIGGER_CANCEL = 0x5b;
const NOTIFY_PARAMETER_CHANGE = 0x5c;
const NOTIFY_PHYSICAL = 0xd0;
const NOTIFY_AUTO_DETECT_RESULT = 0xf1;
const AUTO_DETECT_RESULT_MARKER = 0x61;

export class PawPrintsSensorAdapter implements WebBluetoothSensorAdapter<PawPrintsReading> {
  private state: SensorState = createEmptySensorState();
  private writeChar: BluetoothRemoteGATTCharacteristicLike | null = null;
  private notifyChar: BluetoothRemoteGATTCharacteristicLike | null = null;

  private readonly readingListeners = new Set<PawPrintsReadingListener>();
  private readonly stateListeners = new Set<PawPrintsStateListener>();

  async onConnected(context: WebBluetoothConnectionContext): Promise<void> {
    await this.resetConnection(false);

    // Set the attempted device's name/address optimistically, before GATT
    // connect even starts — if connectSensorGatt() below throws partway
    // through, resetConnection() still has a name/address to preserve, so a
    // failed attempt is distinguishable from "never tried" rather than
    // silently reverting to blank.
    this.state = {
      ...createEmptySensorState(),
      deviceName: context.device.name ?? '',
      address: context.device.id ?? '',
    };

    try {
      const connection = await connectSensorGatt(context, this.handleNotification);
      this.writeChar = connection.writeChar;
      this.notifyChar = connection.notifyChar;
      this.state = {
        connected: true,
        deviceName: connection.deviceName,
        address: connection.address,
        battery: connection.battery,
      };
      this.emitState();

      // The doc requires this write immediately after connecting ("建议先设置
      // 无任何触发模式") — without it the device may proactively drop the BLE
      // connection on its own. Deliberately not best-effort like the V3
      // handshake steps: if this fails, the connection genuinely isn't in
      // the state the device requires, so surfacing the failure (rolling
      // back via the catch block below, like any other step here) is more
      // honest than reporting a successful connection the device is about
      // to drop anyway.
      await this.configureTrigger(0x00, 0x01);
    } catch (error) {
      await this.resetConnection(false);
      throw error;
    }
  }

  async onDisconnected(): Promise<void> {
    await this.resetConnection(true);
  }

  getState(): SensorState {
    return { ...this.state };
  }

  subscribe(listener: PawPrintsReadingListener): () => void {
    this.readingListeners.add(listener);
    return () => {
      this.readingListeners.delete(listener);
    };
  }

  onStateChanged(listener: PawPrintsStateListener): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  /**
   * Sends the 0x50 config/trigger command. `config` is copied into the
   * 14-byte trailing config block (truncated if longer, zero-padded if
   * shorter/omitted).
   */
  async configureTrigger(mode: number, color: number, config?: Uint8Array): Promise<void> {
    const packet = new Uint8Array(17);
    packet[0] = CMD_CONFIGURE_TRIGGER;
    packet[1] = color;
    packet[2] = mode;
    if (config) {
      packet.set(config.subarray(0, 14), 3);
    }
    await this.writeCommand(packet);
  }

  async resetParameters(): Promise<void> {
    await this.writeCommand(Uint8Array.of(CMD_RESET_PARAMETERS));
  }

  async startAngleDetection(): Promise<void> {
    await this.writeCommand(Uint8Array.of(CMD_START_ANGLE_DETECTION));
  }

  async setLedSolid(color: number): Promise<void> {
    await this.writeCommand(Uint8Array.of(CMD_LED_CONTROL, clampIndicatorColor(color)));
  }

  async setLedBlink(color1: number, color2: number, speed: number): Promise<void> {
    await this.writeCommand(
      Uint8Array.of(
        CMD_LED_CONTROL,
        clampIndicatorColor(color1),
        clampIndicatorColor(color2),
        speed,
      ),
    );
  }

  private async resetConnection(emit: boolean): Promise<void> {
    await disconnectSensorGatt(this.notifyChar, this.handleNotification);

    this.writeChar = null;
    this.notifyChar = null;

    const previousDeviceName = this.state.deviceName;
    const previousAddress = this.state.address;
    this.state = {
      ...createEmptySensorState(),
      deviceName: previousDeviceName,
      address: previousAddress,
    };

    if (emit) {
      this.emitState();
    }
  }

  private emitState(): void {
    const snapshot = this.getState();
    for (const listener of this.stateListeners) {
      listener(snapshot);
    }
  }

  private async writeCommand(bytes: Uint8Array): Promise<void> {
    if (!this.writeChar) {
      throw new Error('Paw-Prints sensor is not connected');
    }
    await writeCharacteristicValue(this.writeChar, bytes);
  }

  private readonly handleNotification = (event: Event): void => {
    const target = event.target as BluetoothRemoteGATTCharacteristicLike | null;
    const value = target?.value;
    if (!value || value.byteLength < 1) return;

    const reading = this.parseReading(value);
    if (!reading) return;

    // The device has no dedicated battery service (0x180A read at connect
    // time is best-effort and often unavailable) — 0x51 status messages are
    // the actual ongoing battery source, so fold them into state here or the
    // UI's battery reading stays frozen at whatever connect-time guessed.
    if (reading.type === 'status') {
      this.state = { ...this.state, battery: reading.battery };
      this.emitState();
    }

    for (const listener of this.readingListeners) {
      listener(reading);
    }
  };

  private parseReading(value: DataView): PawPrintsReading | null {
    const opcode = value.getUint8(0);

    switch (opcode) {
      case NOTIFY_STATUS: {
        if (value.byteLength < 4) return null;
        return {
          type: 'status',
          color: value.getUint8(1),
          deviceType: value.getUint8(2),
          battery: value.getUint8(3),
        };
      }

      case NOTIFY_TRIGGER: {
        if (value.byteLength < 4) return null;
        return {
          type: 'trigger',
          eventId: value.getUint8(2),
          parameterValue: value.getUint8(3),
        };
      }

      case NOTIFY_TRIGGER_CANCEL: {
        if (value.byteLength < 3) return null;
        return {
          type: 'triggerCancel',
          eventId: value.getUint8(2),
        };
      }

      case NOTIFY_PARAMETER_CHANGE: {
        if (value.byteLength < 4) return null;
        return {
          type: 'parameterChange',
          eventId: value.getUint8(2),
          value: value.getUint8(3),
        };
      }

      case NOTIFY_PHYSICAL: {
        if (value.byteLength < 9) return null;
        return {
          type: 'physical',
          sequence: value.getUint8(2),
          pressState: value.getUint8(3),
          // Doc states acceleration nominally ranges 0-400 and extVoltage
          // 0-2.1V, neither of which fits cleanly in a single unsigned byte
          // (0-255). Treating both as raw unsigned bytes for now — the true
          // encoding (likely a scaled or clamped representation) needs
          // confirming against a real device capture.
          acceleration: value.getUint8(4),
          angleX: value.getInt8(5),
          angleY: value.getInt8(6),
          angleZ: value.getInt8(7),
          extVoltage: value.getUint8(8),
        };
      }

      case NOTIFY_AUTO_DETECT_RESULT: {
        // The doc's parenthetical total of "(10 bytes)" contradicts its own
        // field breakdown: a 2-byte header (opcode + 0x61 marker) plus three
        // 4-byte ranges (each two little-endian int16 values) is 14 bytes,
        // not 10. Trusting the more specific field-by-field breakdown over
        // the summary byte count — needs confirming against a real capture.
        if (value.byteLength < 14 || value.getUint8(1) !== AUTO_DETECT_RESULT_MARKER) return null;
        return {
          type: 'autoDetectResult',
          xRange: [value.getInt16(2, true), value.getInt16(4, true)],
          yRange: [value.getInt16(6, true), value.getInt16(8, true)],
          zRange: [value.getInt16(10, true), value.getInt16(12, true)],
        };
      }

      default:
        return null;
    }
  }
}
