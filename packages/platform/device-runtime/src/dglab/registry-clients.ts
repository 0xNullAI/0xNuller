import {
  createEmptyDeviceState,
  createEmptySensorState,
  type DeviceClient,
  type DeviceCommand,
  type DeviceCommandResult,
  type DeviceState,
  type OpossumCommand,
  type SensorDeviceClient,
  type SensorState,
} from '@dg-kit/core';
import {
  createEmptyOpossumState,
  type OpossumButtonEvent,
  type OpossumClient,
  type OpossumCommandResult,
  type OpossumState,
} from '@dg-kit/protocol';
import type { DgLabModuleHandle } from './dglab-connection-registry.js';
import type { DgLabSensorKind } from './dglab-transport.js';
import type { DgLabDeviceSnapshot, DgLabReading } from './physical-device.js';

type CoyoteSnapshot = Extract<DgLabDeviceSnapshot, { kind: 'coyote' }>;
type OpossumSnapshot = Extract<DgLabDeviceSnapshot, { kind: 'opossum' }>;

export interface RegistryConnectedCoyote {
  id: string;
  state: DeviceState;
}

/**
 * The module-facing Coyote client on top of a registry handle.
 *
 * It holds no protocol adapter and no BLE link: every write goes through `handle.execute`, so
 * the lease fence, holder re-clamp and the device's single queue apply to it. Implements the
 * `DeviceClient` surface plus the exact-target methods Agent's routers duck-type for.
 */
export class RegistryCoyoteClient implements DeviceClient {
  private readonly handle: DgLabModuleHandle;
  private selectedId: string | null = null;

  constructor(handle: DgLabModuleHandle) {
    this.handle = handle;
  }

  get deviceId(): string | null {
    return this.primary()?.id ?? null;
  }

  async connect(): Promise<void> {
    const picked = await this.handle.connect();
    if (picked.kind === 'coyote') this.selectedId = picked.id;
  }

  /** Every Coyote. The registry stops each one before dropping its link. */
  async disconnect(): Promise<void> {
    await settleAll(this.coyotes().map((coyote) => this.handle.disconnect(coyote.id)));
  }

  async getState(): Promise<DeviceState> {
    return this.primary()?.state ?? createEmptyDeviceState();
  }

  async execute(command: DeviceCommand): Promise<DeviceCommandResult> {
    const primary = this.primary();
    if (!primary) throw new Error('设备未连接');
    return this.handle.execute(primary.id, command);
  }

  /** Every connected Coyote; one unreachable host does not block the others. */
  async emergencyStop(): Promise<void> {
    await settleAll(this.coyotes().map((coyote) => this.handle.emergencyStop(coyote.id)));
  }

  onStateChanged(listener: (state: DeviceState) => void): () => void {
    return this.handle.subscribe(() => {
      listener(this.primary()?.state ?? createEmptyDeviceState());
    });
  }

  getConnectedCoyotes(): RegistryConnectedCoyote[] {
    return this.coyotes().map(({ id, state }) => ({ id, state }));
  }

  async getDeviceStateById(deviceId: string): Promise<DeviceState | null> {
    return this.coyotes().find((coyote) => coyote.id === deviceId)?.state ?? null;
  }

  async executeDeviceById(
    deviceId: string,
    command: DeviceCommand,
  ): Promise<DeviceCommandResult | null> {
    if (!this.coyotes().some((coyote) => coyote.id === deviceId)) return null;
    // Presentation only, as in MultiCoyoteDeviceClient: the UI follows the target the AI drives.
    this.selectedId = deviceId;
    return this.handle.execute(deviceId, command);
  }

  async emergencyStopDeviceById(deviceId: string): Promise<boolean> {
    if (!this.coyotes().some((coyote) => coyote.id === deviceId)) return false;
    await this.handle.emergencyStop(deviceId);
    return true;
  }

  selectDeviceById(deviceId: string): void {
    if (!this.coyotes().some((coyote) => coyote.id === deviceId)) throw new Error('目标郊狼未连接');
    this.selectedId = deviceId;
  }

  async disconnectDeviceById(deviceId: string): Promise<void> {
    if (!this.coyotes().some((coyote) => coyote.id === deviceId)) return;
    await this.handle.disconnect(deviceId);
  }

  private coyotes(): CoyoteSnapshot[] {
    return this.handle
      .list()
      .filter((device): device is CoyoteSnapshot => device.kind === 'coyote' && device.connected);
  }

  private primary(): CoyoteSnapshot | null {
    const connected = this.coyotes();
    return connected.find((coyote) => coyote.id === this.selectedId) ?? connected[0] ?? null;
  }
}

/** Module-facing `OpossumClient`: targets the first connected Opossum through the handle. */
export class RegistryOpossumClient implements OpossumClient {
  private readonly handle: DgLabModuleHandle;

  constructor(handle: DgLabModuleHandle) {
    this.handle = handle;
  }

  get deviceId(): string | null {
    return this.primary()?.id ?? null;
  }

  async connect(): Promise<void> {
    await this.handle.connect();
  }

  async disconnect(): Promise<void> {
    await settleAll(this.opossums().map((device) => this.handle.disconnect(device.id)));
  }

  async getState(): Promise<OpossumState> {
    return this.primary()?.state ?? createEmptyOpossumState();
  }

  async execute(command: OpossumCommand): Promise<OpossumCommandResult> {
    const primary = this.primary();
    if (!primary) throw new Error('设备未连接');
    return this.handle.executeOpossum(primary.id, command);
  }

  async emergencyStop(): Promise<void> {
    await settleAll(this.opossums().map((device) => this.handle.emergencyStop(device.id)));
  }

  async setIndicatorColor(color: number): Promise<void> {
    const primary = this.primary();
    if (!primary) throw new Error('设备未连接');
    await this.handle.setIndicatorColor(primary.id, color);
  }

  onStateChanged(listener: (state: OpossumState) => void): () => void {
    return this.handle.subscribe(() => {
      listener(this.primary()?.state ?? createEmptyOpossumState());
    });
  }

  subscribeButtons(listener: (event: OpossumButtonEvent) => void): () => void {
    return followPrimary(
      this.handle,
      () => this.primary()?.id ?? null,
      (reading) => listener(reading as OpossumButtonEvent),
    );
  }

  private opossums(): OpossumSnapshot[] {
    return this.handle
      .list()
      .filter((device): device is OpossumSnapshot => device.kind === 'opossum' && device.connected);
  }

  private primary(): OpossumSnapshot | null {
    return this.opossums()[0] ?? null;
  }
}

/** Module-facing sensor client for one kind; readings follow the first connected device. */
export class RegistrySensorClient<TReading> implements SensorDeviceClient<TReading> {
  private readonly handle: DgLabModuleHandle;
  private readonly kind: DgLabSensorKind;

  constructor(handle: DgLabModuleHandle, kind: DgLabSensorKind) {
    this.handle = handle;
    this.kind = kind;
  }

  get deviceId(): string | null {
    return this.primary()?.id ?? null;
  }

  async connect(): Promise<void> {
    await this.handle.connect();
  }

  async disconnect(): Promise<void> {
    await settleAll(this.sensors().map((device) => this.handle.disconnect(device.id)));
  }

  async getState(): Promise<SensorState> {
    const primary = this.primary();
    return primary ? (primary.state as SensorState) : createEmptySensorState();
  }

  subscribe(listener: (reading: TReading) => void): () => void {
    return followPrimary(
      this.handle,
      () => this.primary()?.id ?? null,
      (reading) => listener(reading as TReading),
    );
  }

  onStateChanged(listener: (state: SensorState) => void): () => void {
    return this.handle.subscribe(() => {
      const primary = this.primary();
      listener(primary ? (primary.state as SensorState) : createEmptySensorState());
    });
  }

  async setIndicatorColor(color: number): Promise<void> {
    const primary = this.primary();
    if (!primary) throw new Error('设备未连接');
    await this.handle.setIndicatorColor(primary.id, color);
  }

  private sensors(): DgLabDeviceSnapshot[] {
    return this.handle.list().filter((device) => device.kind === this.kind && device.connected);
  }

  private primary(): DgLabDeviceSnapshot | null {
    return this.sensors()[0] ?? null;
  }
}

/** Keep one readings subscription on whichever device `pick` names, rewiring on topology change. */
function followPrimary(
  handle: DgLabModuleHandle,
  pick: () => string | null,
  listener: (reading: DgLabReading) => void,
): () => void {
  let currentId: string | null = null;
  let unsubscribeReadings: () => void = () => undefined;
  const rewire = () => {
    const next = pick();
    if (next === currentId) return;
    unsubscribeReadings();
    currentId = next;
    unsubscribeReadings = next ? handle.readings(next, listener) : () => undefined;
  };
  rewire();
  const unsubscribeTopology = handle.subscribe(rewire);
  return () => {
    unsubscribeTopology();
    unsubscribeReadings();
  };
}

/** Attempt every action; report the first failure only after all of them ran. */
async function settleAll(actions: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(actions);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) throw failure.reason;
}
