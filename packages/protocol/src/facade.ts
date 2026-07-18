import { detectDeviceKind, V2_DEVICE_NAME_PREFIX } from './constants.js';
import type { DeviceCommand, DeviceCommandResult, DeviceState } from '@dg-kit/core';
import {
  type StateListener,
  type WebBluetoothConnectionContext,
  type WebBluetoothProtocolAdapter,
} from './base.js';
import { CoyoteV2ProtocolAdapter } from './v2.js';
import { CoyoteV3ProtocolAdapter } from './v3.js';

/**
 * Auto-routing protocol adapter — Coyote only. Picks the V2 or V3
 * implementation based on the connecting device's name prefix.
 *
 * This does NOT route paw-prints/civet-edging/opossum devices, even though
 * `DG_LAB_REQUEST_DEVICE_OPTIONS`'s broader scan filter will surface them in
 * the same chooser as Coyote units. Those three device kinds share Coyote
 * V3's exact GATT skeleton but speak a completely different command
 * vocabulary — silently defaulting an unrecognized device to
 * `CoyoteV3ProtocolAdapter` (the previous behavior) would send Coyote B0/BF
 * stim frames to, say, a pressure sensor. `createProtocol()` now throws
 * instead: callers that scan with the broader filter must classify the
 * result with `detectDeviceKind()` first and only hand Coyote-kind devices
 * to this facade, using `PawPrintsSensorAdapter`/`CivetPressureSensorAdapter`/
 * `OpossumVibrateAdapter` directly for the other three kinds.
 */
export class CoyoteProtocolAdapter implements WebBluetoothProtocolAdapter {
  private readonly listeners = new Set<StateListener>();
  private activeProtocol: WebBluetoothProtocolAdapter = new CoyoteV3ProtocolAdapter();
  private unsubscribeActiveProtocol: (() => void) | null = null;

  constructor() {
    this.bindActiveProtocol(this.activeProtocol);
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async onConnected(context: WebBluetoothConnectionContext): Promise<void> {
    const nextProtocol = this.createProtocol(context);
    await nextProtocol.onConnected(context);

    const previousProtocol = this.activeProtocol;
    if (previousProtocol !== nextProtocol) {
      try {
        await previousProtocol.onDisconnected();
      } catch (error) {
        try {
          await nextProtocol.onDisconnected();
        } catch {
          // ignore cleanup failure; preserve the original disconnect error
        }
        throw error;
      }
    }

    this.bindActiveProtocol(nextProtocol);
    this.emit(nextProtocol.getState());
  }

  async onDisconnected(): Promise<void> {
    await this.activeProtocol.onDisconnected();
  }

  getState(): DeviceState {
    return this.activeProtocol.getState();
  }

  async execute(command: DeviceCommand): Promise<DeviceCommandResult> {
    return this.activeProtocol.execute(command);
  }

  async emergencyStop(): Promise<void> {
    await this.activeProtocol.emergencyStop();
  }

  async setLimits(limitA: number, limitB: number): Promise<void> {
    await this.activeProtocol.setLimits(limitA, limitB);
  }

  private createProtocol(context: WebBluetoothConnectionContext): WebBluetoothProtocolAdapter {
    const name = context.device.name ?? '';
    const kind = detectDeviceKind(name);
    if (kind !== 'coyote') {
      throw new Error(
        `CoyoteProtocolAdapter only supports Coyote devices, but "${name}" was classified as ` +
          `"${kind}". Use PawPrintsSensorAdapter/CivetPressureSensorAdapter/OpossumVibrateAdapter ` +
          'directly for that device kind instead of routing it through this facade.',
      );
    }
    return name.startsWith(V2_DEVICE_NAME_PREFIX)
      ? new CoyoteV2ProtocolAdapter()
      : new CoyoteV3ProtocolAdapter();
  }

  private bindActiveProtocol(protocol: WebBluetoothProtocolAdapter): void {
    this.unsubscribeActiveProtocol?.();
    this.activeProtocol = protocol;
    this.unsubscribeActiveProtocol = protocol.subscribe((state) => {
      if (this.activeProtocol === protocol) {
        this.emit(state);
      }
    });
  }

  private emit(state: DeviceState): void {
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
