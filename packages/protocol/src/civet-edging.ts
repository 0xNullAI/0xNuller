import { createEmptySensorState, type SensorState } from '@dg-kit/core';
import type { WebBluetoothConnectionContext, WebBluetoothSensorAdapter } from './base.js';
import {
  V3_BATTERY_CHAR,
  V3_BATTERY_SERVICE,
  V3_NOTIFY_CHAR,
  V3_PRIMARY_SERVICE,
  V3_WRITE_CHAR,
} from './constants.js';
import type { BluetoothRemoteGATTCharacteristicLike } from './types.js';

/**
 * Civet Edging Sensor (灵猫边缘控制传感器) — a barometric pressure sensor used
 * for edging control. Single-variant reading type on purpose: unlike
 * paw-prints (which can push several distinct event shapes), this device
 * only ever streams pressure samples. The `type` discriminant is kept anyway
 * so downstream consumers that fan-in readings from multiple sensor kinds
 * can still narrow on it.
 */
export interface CivetPressureReading {
  type: 'pressure';
  kPa: number;
}

type ReadingListener = (reading: CivetPressureReading) => void;
type StateListener = (state: SensorState) => void;

/**
 * Web Bluetooth adapter for the Civet Edging Sensor.
 *
 * Shares the exact same GATT skeleton as Coyote V3 (service 0x180C, write
 * 0x150A, notify 0x150B, battery 0x180A/0x1500) — only the application-layer
 * opcodes differ. See constants.ts for why no new UUIDs are declared.
 */
export class CivetPressureSensorAdapter implements WebBluetoothSensorAdapter<CivetPressureReading> {
  private readonly readingListeners = new Set<ReadingListener>();
  private readonly stateListeners = new Set<StateListener>();

  private state: SensorState = createEmptySensorState();
  private writeChar: BluetoothRemoteGATTCharacteristicLike | null = null;
  private notifyChar: BluetoothRemoteGATTCharacteristicLike | null = null;

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
        const batteryChar = await batteryService.getCharacteristic(V3_BATTERY_CHAR);
        const value = await batteryChar.readValue();
        battery = value.getUint8(0);
      } catch {
        battery = 0;
      }

      this.state = {
        connected: true,
        deviceName: context.device.name ?? '',
        address: context.device.id ?? '',
        battery,
      };
      this.emitState();

      // Auto-start streaming right after connecting so the adapter is
      // immediately useful, mirroring CoyoteV3ProtocolAdapter's proactive
      // BF write in its own onConnected. The caller has no opportunity to
      // call startPressureReporting() earlier since the write char doesn't
      // exist until this method resolves.
      await this.startPressureReporting();
    } catch (error) {
      await this.onDisconnected();
      throw error;
    }
  }

  async onDisconnected(): Promise<void> {
    if (this.notifyChar) {
      this.notifyChar.removeEventListener('characteristicvaluechanged', this.handleNotification);
      try {
        await this.notifyChar.stopNotifications();
      } catch {
        // best-effort: device may already be gone.
      }
    }

    this.writeChar = null;
    this.notifyChar = null;
    this.state = createEmptySensorState();
    this.emitState();
  }

  getState(): SensorState {
    return { ...this.state };
  }

  subscribe(listener: ReadingListener): () => void {
    this.readingListeners.add(listener);
    return () => {
      this.readingListeners.delete(listener);
    };
  }

  onStateChanged(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  /** `0x50` pressure-reporting toggle: start streaming pressure notifications. */
  async startPressureReporting(color = 0x00): Promise<void> {
    await this.write(this.buildPressureReportingPacket(color, 0xd0));
  }

  /** `0x50` pressure-reporting toggle: stop streaming pressure notifications. */
  async stopPressureReporting(color = 0x00): Promise<void> {
    await this.write(this.buildPressureReportingPacket(color, 0x00));
  }

  /** `0x66` calibration: reset the pressure baseline to the current reading. */
  async calibrateZero(): Promise<void> {
    // prettier-ignore
    await this.write(new Uint8Array([0x66, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x02]));
  }

  /** `0x66` calibration: toggle the on-device screen rotation. */
  async toggleRotation(next: 0x01 | 0x03): Promise<void> {
    // prettier-ignore
    await this.write(new Uint8Array([0x66, 0, 0, 0, 0, 0, 0, 0, 0, 0, next, 0, 0]));
  }

  private buildPressureReportingPacket(color: number, startStopByte: number): Uint8Array {
    const buffer = new Uint8Array(17);
    buffer[0] = 0x50;
    buffer[1] = color & 0xff;
    buffer[2] = startStopByte;
    // Remaining 14 bytes are zero padding (Uint8Array is zero-initialized).
    return buffer;
  }

  private async write(value: Uint8Array): Promise<void> {
    if (!this.writeChar) {
      throw new Error('设备未连接');
    }
    await this.writeCharacteristicValue(this.writeChar, value);
  }

  /**
   * Same writeValueWithoutResponse/writeValueWithResponse/writeValue
   * fallback chain as BaseCoyoteProtocolAdapter.writeCharacteristicValue in
   * base.ts, reimplemented here since that method is protected on a class
   * this adapter doesn't extend.
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

  private emitState(): void {
    const snapshot = this.getState();
    for (const listener of this.stateListeners) {
      listener(snapshot);
    }
  }

  readonly handleNotification = (event: Event): void => {
    const target = event.target as BluetoothRemoteGATTCharacteristicLike | null;
    const value = target?.value;
    if (!value || value.byteLength < 10 || value.getUint8(0) !== 0xd0) return;

    // Signed little-endian int16 at byte offset 8-9, in centi-kPa.
    const raw = value.getInt16(8, true);
    const reading: CivetPressureReading = { type: 'pressure', kPa: raw / 100 };
    for (const listener of this.readingListeners) {
      listener(reading);
    }
  };
}
