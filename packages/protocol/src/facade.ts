import { V2_DEVICE_NAME_PREFIX } from './constants.js';
import type { DeviceCommand, DeviceCommandResult, DeviceState } from '@dg-kit/core';
import {
  type StateListener,
  type WebBluetoothConnectionContext,
  type WebBluetoothProtocolAdapter,
} from './base.js';
import { CoyoteV2ProtocolAdapter } from './v2.js';
import { CoyoteV3ProtocolAdapter } from './v3.js';

/**
 * Auto-routing protocol adapter. Picks the V2 or V3 implementation based on
 * the connecting device's name prefix; defaults to V3.
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
