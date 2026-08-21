import {
  createEmptyDeviceState,
  type DeviceClient,
  type DeviceCommand,
  type DeviceCommandResult,
  type DeviceState,
} from '@dg-agent/core';
import {
  CoyoteProtocolAdapter,
  type BluetoothDeviceLike,
  type BluetoothRemoteGATTServerLike,
} from '@dg-kit/protocol';

interface AttachCapableDeviceClient extends DeviceClient {
  connectDevice(device: BluetoothDeviceLike, server: BluetoothRemoteGATTServerLike): Promise<void>;
  readonly deviceId?: string | null;
}

interface CoyoteSlot {
  id: string;
  client: DeviceClient;
  state: DeviceState;
  unsubscribe: () => void;
}

export interface ConnectedCoyote {
  id: string;
  state: DeviceState;
}

export type CoyoteDeviceClientFactory = (protocol: CoyoteProtocolAdapter) => DeviceClient;

/**
 * Agent-facing aggregate for any number of Coyote hosts.
 *
 * Each host owns a separate protocol adapter and transport client, preserving
 * independent queues, limits and emergency-stop paths. The ordinary
 * DeviceClient surface continues to address the first connected host so old
 * Agent tools remain compatible; emergencyStop/disconnect cover every host.
 */
export class MultiCoyoteDeviceClient implements DeviceClient {
  private readonly slots: CoyoteSlot[] = [];
  private readonly listeners = new Set<(state: DeviceState) => void>();
  private nextFallbackId = 1;

  constructor(private readonly createClient: CoyoteDeviceClientFactory) {}

  get deviceId(): string | null {
    return this.primarySlot()?.id ?? null;
  }

  async connect(): Promise<void> {
    const slot = this.createSlot(`coyote-${this.nextFallbackId++}`);
    try {
      await slot.client.connect();
      slot.id = clientDeviceId(slot.client) ?? slot.id;
      slot.state = await slot.client.getState();
      this.emit();
    } catch (error) {
      this.removeSlot(slot);
      throw error;
    }
  }

  async connectDevice(
    device: BluetoothDeviceLike,
    server: BluetoothRemoteGATTServerLike,
  ): Promise<void> {
    const requestedId = device.id?.trim() || `coyote-${this.nextFallbackId++}`;
    const existing = this.slots.find((slot) => slot.id === requestedId);
    if (existing) {
      const client = asAttachCapable(existing.client);
      await client.connectDevice(device, server);
      existing.state = await existing.client.getState();
      this.emit();
      return;
    }

    const slot = this.createSlot(requestedId);
    try {
      const client = asAttachCapable(slot.client);
      await client.connectDevice(device, server);
      slot.id = clientDeviceId(slot.client) ?? requestedId;
      slot.state = await slot.client.getState();
      this.emit();
    } catch (error) {
      this.removeSlot(slot);
      if (device.gatt?.connected) device.gatt.disconnect();
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    const slots = [...this.slots];
    const results = await Promise.allSettled(slots.map((slot) => slot.client.disconnect()));
    for (const slot of slots) this.removeSlot(slot);
    this.emit();
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure) throw failure.reason;
  }

  async disconnectDeviceById(deviceId: string): Promise<void> {
    const slot = this.slots.find((candidate) => candidate.id === deviceId);
    if (!slot) return;
    try {
      await slot.client.disconnect();
    } finally {
      this.removeSlot(slot);
      this.emit();
    }
  }

  async getState(): Promise<DeviceState> {
    const primary = this.primarySlot();
    return primary ? primary.client.getState() : createEmptyDeviceState();
  }

  async execute(command: DeviceCommand): Promise<DeviceCommandResult> {
    const primary = this.primarySlot();
    if (!primary) throw new Error('设备未连接');
    return primary.client.execute(command);
  }

  async emergencyStop(): Promise<void> {
    // Never let one unreachable host prevent the stop command reaching the
    // others. This is the Agent and shell panic-button path.
    await Promise.allSettled(this.connectedSlots().map((slot) => slot.client.emergencyStop()));
  }

  onStateChanged(listener: (state: DeviceState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Synchronous snapshot used by Agent's global device bar. */
  getConnectedCoyotes(): ConnectedCoyote[] {
    return this.connectedSlots().map((slot) => ({ id: slot.id, state: { ...slot.state } }));
  }

  private createSlot(id: string): CoyoteSlot {
    const client = this.createClient(new CoyoteProtocolAdapter());
    const slot: CoyoteSlot = {
      id,
      client,
      state: createEmptyDeviceState(),
      unsubscribe: () => undefined,
    };
    slot.unsubscribe = client.onStateChanged((state) => {
      slot.state = state;
      this.emit();
    });
    this.slots.push(slot);
    return slot;
  }

  private connectedSlots(): CoyoteSlot[] {
    return this.slots.filter((slot) => slot.state.connected);
  }

  private primarySlot(): CoyoteSlot | null {
    return this.connectedSlots()[0] ?? null;
  }

  private removeSlot(slot: CoyoteSlot): void {
    const index = this.slots.indexOf(slot);
    if (index >= 0) this.slots.splice(index, 1);
    slot.unsubscribe();
  }

  private emit(): void {
    const state = this.primarySlot()?.state ?? createEmptyDeviceState();
    for (const listener of this.listeners) listener({ ...state });
  }
}

function asAttachCapable(client: DeviceClient): AttachCapableDeviceClient {
  if (typeof (client as Partial<AttachCapableDeviceClient>).connectDevice !== 'function') {
    throw new Error('当前环境不支持免二次选择器连接郊狼设备');
  }
  return client as AttachCapableDeviceClient;
}

function clientDeviceId(client: DeviceClient): string | null {
  const id = (client as Partial<AttachCapableDeviceClient>).deviceId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}
