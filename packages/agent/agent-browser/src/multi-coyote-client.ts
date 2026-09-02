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
  /** Aggregate-local id. Unlike some BLE transports, this is always unique. */
  id: string;
  sourceDevice?: BluetoothDeviceLike;
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
 * independent transports and emergency-stop paths. The ordinary DeviceClient
 * surface remains for UI compatibility; model calls use the exact-target APIs
 * and never fall back to this primary selection.
 */
export class MultiCoyoteDeviceClient implements DeviceClient {
  private readonly slots: CoyoteSlot[] = [];
  private readonly listeners = new Set<(state: DeviceState) => void>();
  private selectedSlotId: string | null = null;

  constructor(
    private readonly createClient: CoyoteDeviceClientFactory,
    private readonly createTargetId: () => string = defaultTargetId,
  ) {}

  get deviceId(): string | null {
    return this.primarySlot()?.id ?? null;
  }

  async connect(): Promise<void> {
    const slot = this.createSlot(this.nextOpaqueTargetId());
    try {
      await slot.client.connect();
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
    // A reconnect of the exact same BluetoothDevice belongs to its old slot.
    // Different hosts can nevertheless expose the same transport id (notably
    // through some native BLE adapters), so id equality alone must never merge
    // two physical devices into one client.
    const existing = this.slots.find((slot) => slot.sourceDevice === device);
    if (existing) {
      const client = asAttachCapable(existing.client);
      await client.connectDevice(device, server);
      existing.state = await existing.client.getState();
      this.emit();
      return;
    }

    const slot = this.createSlot(this.nextOpaqueTargetId(), device);
    try {
      const client = asAttachCapable(slot.client);
      await client.connectDevice(device, server);
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

  async emergencyStopDeviceById(deviceId: string): Promise<boolean> {
    const slot = this.connectedSlots().find((candidate) => candidate.id === deviceId);
    if (!slot) return false;
    await slot.client.emergencyStop();
    return true;
  }

  selectDeviceById(deviceId: string): void {
    const slot = this.connectedSlots().find((candidate) => candidate.id === deviceId);
    if (!slot) throw new Error('目标郊狼未连接');
    this.selectedSlotId = slot.id;
    this.emit();
  }

  async getState(): Promise<DeviceState> {
    const primary = this.primarySlot();
    return primary ? primary.client.getState() : createEmptyDeviceState();
  }

  async getDeviceStateById(deviceId: string): Promise<DeviceState | null> {
    const slot = this.connectedSlots().find((candidate) => candidate.id === deviceId);
    return slot ? slot.client.getState() : null;
  }

  async execute(command: DeviceCommand): Promise<DeviceCommandResult> {
    const primary = this.primarySlot();
    if (!primary) throw new Error('设备未连接');
    return primary.client.execute(command);
  }

  async executeDeviceById(
    deviceId: string,
    command: DeviceCommand,
  ): Promise<DeviceCommandResult | null> {
    const slot = this.connectedSlots().find((candidate) => candidate.id === deviceId);
    if (!slot) return null;

    // Exact-target model calls bypass the legacy selected-device surface. Keep the
    // human-facing projection on the target the AI is operating so its live strength,
    // battery and waveform state do not stay visually pinned to another connected host.
    // This changes presentation only: execution still uses the exact slot resolved above.
    if (this.selectedSlotId !== slot.id) {
      this.selectedSlotId = slot.id;
      this.emit();
    }
    return slot.client.execute(command);
  }

  async emergencyStop(): Promise<void> {
    // Never let one unreachable host prevent the stop command reaching the
    // others. Report a failure only after every connected host was attempted.
    const results = await Promise.allSettled(
      this.connectedSlots().map((slot) => slot.client.emergencyStop()),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure) throw failure.reason;
  }

  onStateChanged(listener: (state: DeviceState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Synchronous snapshot used by Agent's global device bar. */
  getConnectedCoyotes(): ConnectedCoyote[] {
    return this.connectedSlots().map((slot) => ({ id: slot.id, state: { ...slot.state } }));
  }

  private createSlot(id: string, sourceDevice?: BluetoothDeviceLike): CoyoteSlot {
    const client = this.createClient(new CoyoteProtocolAdapter());
    const slot: CoyoteSlot = {
      id,
      sourceDevice,
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

  private nextOpaqueTargetId(): string {
    const used = new Set(this.slots.map((slot) => slot.id));
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const id = this.createTargetId().trim();
      if (id && !used.has(id)) return id;
    }
    throw new Error('无法分配唯一郊狼目标身份');
  }

  private connectedSlots(): CoyoteSlot[] {
    return this.slots.filter((slot) => slot.state.connected);
  }

  private primarySlot(): CoyoteSlot | null {
    const connected = this.connectedSlots();
    return connected.find((slot) => slot.id === this.selectedSlotId) ?? connected[0] ?? null;
  }

  private removeSlot(slot: CoyoteSlot): void {
    const index = this.slots.indexOf(slot);
    if (index >= 0) this.slots.splice(index, 1);
    if (this.selectedSlotId === slot.id) this.selectedSlotId = null;
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

function defaultTargetId(): string {
  return `coyote/${crypto.randomUUID()}`;
}
