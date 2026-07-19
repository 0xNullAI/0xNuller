/**
 * Tauri-backed Opossum vibrate-controller client. Mirrors DG-Agent's
 * `WebBluetoothOpossumClient` (`packages/device-webbluetooth/src/opossum-client.ts`)
 * — same wrapping of `@dg-kit/protocol`'s `OpossumVibrateAdapter`, same
 * `execute(OpossumCommand)` translation (both `OpossumCommand` and
 * `OpossumState` are plain `@dg-kit/*` types, not agent-specific, so this
 * class can implement the full surface here rather than leaving `execute()`
 * to a downstream composition layer) — only the connection mechanism
 * differs: `connectTauriAuxDevice()` (scan + host picker + plugin-blec)
 * instead of `navigator.bluetooth.requestDevice()`.
 */
import type { OpossumCommand } from '@dg-kit/core';
import {
  OPOSSUM_DEVICE_NAME_PREFIX,
  OpossumVibrateAdapter,
  type OpossumButtonEvent,
  type OpossumState,
} from '@dg-kit/protocol';
import type { BluetoothDeviceLike, BluetoothRemoteGATTServerLike } from '@dg-kit/protocol';
import {
  attachTauriAuxDevice,
  connectTauriAuxDevice,
  disconnectTauriAuxDevice,
} from './aux-connect.js';
import type { GattReadyRetryOptions } from './gatt-ready.js';
import type { DeviceSelectionController } from './scan.js';

export interface OpossumCommandResult {
  state: OpossumState;
}

export interface TauriBlecOpossumClientOptions extends GattReadyRetryOptions {
  selectDevice: (controller: DeviceSelectionController) => Promise<string | null>;
  /** Overrides the default Opossum-only scan filter — mainly for tests. */
  namePrefixes?: string[];
  scanDurationMs?: number;
}

export class TauriBlecOpossumClient {
  private readonly adapter = new OpossumVibrateAdapter();
  private readonly listeners = new Set<(state: OpossumState) => void>();
  private device: BluetoothDeviceLike | null = null;

  constructor(private readonly options: TauriBlecOpossumClientOptions) {
    this.adapter.onStateChanged((state) => this.emit(state));
  }

  /** The BLE address of the currently-connected device, or `null` if disconnected. */
  get address(): string | null {
    return this.device?.id ?? null;
  }

  async connect(): Promise<void> {
    this.device = await connectTauriAuxDevice(
      {
        selectDevice: this.options.selectDevice,
        namePrefixes: this.options.namePrefixes ?? [OPOSSUM_DEVICE_NAME_PREFIX],
        scanDurationMs: this.options.scanDurationMs,
        gattReadyInitialDelayMs: this.options.gattReadyInitialDelayMs,
        gattReadyTimeoutMs: this.options.gattReadyTimeoutMs,
        gattReadyIntervalMs: this.options.gattReadyIntervalMs,
        gattReadyErrorPatterns: this.options.gattReadyErrorPatterns,
      },
      this.adapter,
      this.device,
      this.handleGattDisconnected,
    );
  }

  /**
   * Attach to an already-obtained `(device, server)` pair instead of
   * running this client's own scan + picker — see `aux-connect.ts`'s
   * `attachTauriAuxDevice()` doc comment. Lets a unified cross-kind picker
   * (`requestDgLabDeviceTauri()`) hand a picked+connected Opossum straight
   * to this client once `detectDeviceKind()` identifies it.
   */
  async connectDevice(
    device: BluetoothDeviceLike,
    server: BluetoothRemoteGATTServerLike,
  ): Promise<void> {
    this.device = await attachTauriAuxDevice(
      device,
      server,
      this.adapter,
      this.device,
      this.handleGattDisconnected,
      this.options,
    );
  }

  async disconnect(): Promise<void> {
    const device = this.device;
    this.device = null;
    await disconnectTauriAuxDevice(device, this.adapter, this.handleGattDisconnected);
  }

  async getState(): Promise<OpossumState> {
    return this.adapter.getState();
  }

  async execute(command: OpossumCommand): Promise<OpossumCommandResult> {
    switch (command.type) {
      case 'vibrateStart':
        await this.adapter.setIntensity(
          command.channel === 'A' ? command.intensity : 'unchanged',
          command.channel === 'B' ? command.intensity : 'unchanged',
        );
        break;
      case 'vibrateStop':
        if (command.channel) {
          await this.adapter.setIntensity(
            command.channel === 'A' ? 0 : 'unchanged',
            command.channel === 'B' ? 0 : 'unchanged',
          );
        } else {
          await this.adapter.emergencyStop();
        }
        break;
      case 'vibrateAdjust':
        await this.adapter.adjustIntensity(command.channel, command.delta);
        break;
    }
    return { state: this.adapter.getState() };
  }

  async emergencyStop(): Promise<void> {
    await this.adapter.emergencyStop();
  }

  async setIndicatorColor(color: number): Promise<void> {
    // enableButtonReporting stays on — a purely cosmetic color change must
    // not silently disable the button-press notifications a caller relies
    // on, mirroring the Web Bluetooth client's identical choice.
    await this.adapter.setLed(color, true);
  }

  subscribeButtons(listener: (event: OpossumButtonEvent) => void): () => void {
    return this.adapter.subscribeButtons(listener);
  }

  onStateChanged(listener: (state: OpossumState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private readonly handleGattDisconnected = (): void => {
    const device = this.device;
    this.device = null;
    device?.removeEventListener('gattserverdisconnected', this.handleGattDisconnected);
    void this.adapter.onDisconnected();
  };

  private emit(state: OpossumState): void {
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
