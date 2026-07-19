/**
 * Tauri-backed sensor client (paw-prints / civet-edging). Mirrors DG-Agent's
 * `WebBluetoothSensorClient<TReading>`
 * (`packages/device-webbluetooth/src/sensor-client.ts`) — a single generic
 * client wraps either of `@dg-kit/protocol`'s sensor adapters
 * (`PawPrintsSensorAdapter`, `CivetPressureSensorAdapter`), since they share
 * the exact same `WebBluetoothSensorAdapter<TReading>` shape and only their
 * LED-setting method name differs. Only the connection mechanism differs
 * from the Web Bluetooth version: `connectTauriAuxDevice()` instead of
 * `navigator.bluetooth.requestDevice()`.
 */
import type { SensorState } from '@dg-kit/core';
import {
  CIVET_DEVICE_NAME_PREFIX,
  CivetPressureSensorAdapter,
  PAW_PRINTS_DEVICE_NAME_PREFIX,
  PawPrintsSensorAdapter,
  type BluetoothDeviceLike,
  type CivetPressureReading,
  type PawPrintsReading,
  type WebBluetoothSensorAdapter,
} from '@dg-kit/protocol';
import { connectTauriAuxDevice, disconnectTauriAuxDevice } from './aux-connect.js';
import type { GattReadyRetryOptions } from './gatt-ready.js';
import type { DeviceSelectionController } from './scan.js';

export interface TauriBlecSensorClientOptions<TReading> extends GattReadyRetryOptions {
  adapter: WebBluetoothSensorAdapter<TReading>;
  selectDevice: (controller: DeviceSelectionController) => Promise<string | null>;
  namePrefixes: string[];
  scanDurationMs?: number;
  setIndicatorColor: (color: number) => Promise<void>;
}

export class TauriBlecSensorClient<TReading> {
  private readonly listeners = new Set<(state: SensorState) => void>();
  private device: BluetoothDeviceLike | null = null;

  constructor(private readonly options: TauriBlecSensorClientOptions<TReading>) {
    this.options.adapter.onStateChanged((state) => this.emit(state));
  }

  /** The BLE address of the currently-connected device, or `null` if disconnected. */
  get address(): string | null {
    return this.device?.id ?? null;
  }

  async connect(): Promise<void> {
    this.device = await connectTauriAuxDevice(
      {
        selectDevice: this.options.selectDevice,
        namePrefixes: this.options.namePrefixes,
        scanDurationMs: this.options.scanDurationMs,
        gattReadyInitialDelayMs: this.options.gattReadyInitialDelayMs,
        gattReadyTimeoutMs: this.options.gattReadyTimeoutMs,
        gattReadyIntervalMs: this.options.gattReadyIntervalMs,
        gattReadyErrorPatterns: this.options.gattReadyErrorPatterns,
      },
      this.options.adapter,
      this.device,
      this.handleGattDisconnected,
    );
  }

  async disconnect(): Promise<void> {
    const device = this.device;
    this.device = null;
    await disconnectTauriAuxDevice(device, this.options.adapter, this.handleGattDisconnected);
  }

  async getState(): Promise<SensorState> {
    return this.options.adapter.getState();
  }

  subscribe(listener: (reading: TReading) => void): () => void {
    return this.options.adapter.subscribe(listener);
  }

  onStateChanged(listener: (state: SensorState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async setIndicatorColor(color: number): Promise<void> {
    await this.options.setIndicatorColor(color);
  }

  private readonly handleGattDisconnected = (): void => {
    const device = this.device;
    this.device = null;
    device?.removeEventListener('gattserverdisconnected', this.handleGattDisconnected);
    void this.options.adapter.onDisconnected();
  };

  private emit(state: SensorState): void {
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}

export interface TauriBlecAuxSensorClientOptions extends GattReadyRetryOptions {
  selectDevice: (controller: DeviceSelectionController) => Promise<string | null>;
  /** Overrides the default kind-scoped scan filter — mainly for tests. */
  namePrefixes?: string[];
  scanDurationMs?: number;
}

export class TauriBlecPawPrintsClient extends TauriBlecSensorClient<PawPrintsReading> {
  constructor(options: TauriBlecAuxSensorClientOptions) {
    const adapter = new PawPrintsSensorAdapter();
    super({
      adapter,
      selectDevice: options.selectDevice,
      namePrefixes: options.namePrefixes ?? [PAW_PRINTS_DEVICE_NAME_PREFIX],
      scanDurationMs: options.scanDurationMs,
      gattReadyInitialDelayMs: options.gattReadyInitialDelayMs,
      gattReadyTimeoutMs: options.gattReadyTimeoutMs,
      gattReadyIntervalMs: options.gattReadyIntervalMs,
      gattReadyErrorPatterns: options.gattReadyErrorPatterns,
      // Paw-prints exposes a dedicated "set solid color" LED command.
      setIndicatorColor: (color) => adapter.setLedSolid(color),
    });
  }
}

export class TauriBlecCivetEdgingClient extends TauriBlecSensorClient<CivetPressureReading> {
  constructor(options: TauriBlecAuxSensorClientOptions) {
    const adapter = new CivetPressureSensorAdapter();
    super({
      adapter,
      selectDevice: options.selectDevice,
      namePrefixes: options.namePrefixes ?? [CIVET_DEVICE_NAME_PREFIX],
      scanDurationMs: options.scanDurationMs,
      gattReadyInitialDelayMs: options.gattReadyInitialDelayMs,
      gattReadyTimeoutMs: options.gattReadyTimeoutMs,
      gattReadyIntervalMs: options.gattReadyIntervalMs,
      gattReadyErrorPatterns: options.gattReadyErrorPatterns,
      // civet-edging has no standalone "set color" opcode — setIndicatorColor()
      // re-sends the pressure-reporting packet with streaming state preserved.
      setIndicatorColor: (color) => adapter.setIndicatorColor(color),
    });
  }
}
