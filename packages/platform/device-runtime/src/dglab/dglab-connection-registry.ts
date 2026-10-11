import { isCoyoteOutputActive, type DeviceCommand, type OpossumCommand } from '@dg-kit/core';
import type { BluetoothDeviceLike } from '@dg-kit/protocol';
import {
  currentDeviceLeaseSnapshot,
  registerSafetySession,
  subscribeSafetySessions,
  type DeviceLeaseSnapshot,
  type DeviceSummary,
} from '@dg-kit/safety';
import type { DgLabTransport } from './dglab-transport.js';
import type { HolderSafetyLimits } from './holder-limits.js';
import { admitUnderLease, type LeaseFence } from './lease-fence.js';
import {
  DgLabCommandRejectedError,
  PhysicalDgLabDevice,
  type CoyoteWriteResult,
  type DgLabDeviceSnapshot,
  type DgLabReading,
  type OpossumWriteResult,
} from './physical-device.js';

export const DGLAB_SAFETY_SESSION_ID = 'dglab-devices';

export interface DgLabConnectionRegistryOptions {
  transport: DgLabTransport;
  /** Read at every write, so a lowered setting applies to work already queued. */
  limits: () => HolderSafetyLimits;
  /** Opaque target id factory. Retried on collision. */
  createId?: (kind: string) => string;
  label?: string;
}

export interface DgLabStopAllResult {
  attempted: number;
  failed: { id: string; error: unknown }[];
}

/** What one module may do. Every output write is lease-fenced and re-clamped by the holder. */
export interface DgLabModuleHandle {
  readonly moduleId: string;
  /** Read-only topology, shared by every module. */
  list(): DgLabDeviceSnapshot[];
  subscribe(listener: () => void): () => void;
  /** Open the one shared picker. Concurrent calls share it. */
  connect(): Promise<DgLabDeviceSnapshot>;
  disconnect(id: string): Promise<void>;
  execute(id: string, command: DeviceCommand): Promise<CoyoteWriteResult>;
  executeOpossum(id: string, command: OpossumCommand): Promise<OpossumWriteResult>;
  setIndicatorColor(id: string, color: number): Promise<void>;
  /** Never lease-gated. Omit `id` to stop every Coyote and Opossum. */
  emergencyStop(id?: string): Promise<void>;
  readings(id: string, listener: (reading: DgLabReading) => void): () => void;
  /** Called when this module loses the lease, right after every output stop was issued. */
  onRevoked(listener: () => void): () => void;
}

/**
 * The single owner of every DG-Lab BLE connection in the app.
 *
 * Modules used to each open their own connection and tick loop, so the same Coyote could carry
 * two adapters fighting over one characteristic. Here a physical device gets exactly one
 * `PhysicalDgLabDevice`, and modules borrow it through a lease-gated handle.
 */
export class DgLabConnectionRegistry {
  private readonly transport: DgLabTransport;
  private readonly limits: () => HolderSafetyLimits;
  private readonly createId: (kind: string) => string;
  private readonly devices: PhysicalDgLabDevice[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly revokedListeners = new Map<string, Set<() => void>>();
  private readonly unregisterSession: () => void;
  private readonly unsubscribeLease: () => void;
  private lease: DeviceLeaseSnapshot = currentDeviceLeaseSnapshot();
  private pendingConnect: Promise<DgLabDeviceSnapshot> | null = null;
  private disposed = false;

  constructor(options: DgLabConnectionRegistryOptions) {
    this.transport = options.transport;
    this.limits = options.limits;
    this.createId = options.createId ?? ((kind) => `${kind}/${crypto.randomUUID()}`);

    this.unregisterSession = registerSafetySession({
      id: DGLAB_SAFETY_SESSION_ID,
      label: options.label ?? 'DG-Lab 设备',
      isActive: () => this.devices.some((device) => device.connected),
      stop: async () => {
        await this.stopAll();
      },
      devices: () => this.devices.map((device) => toDeviceSummary(device, this.limits())),
      connect: () => this.connect(),
      disconnect: (id) => this.disconnect(id),
    });
    this.unsubscribeLease = subscribeSafetySessions(() => this.onSafetyBusChange());
  }

  list(): DgLabDeviceSnapshot[] {
    return this.devices.map((device) => device.snapshot());
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Single-flight: a second caller while the picker is open gets the same result instead of a
   * second chooser. Picking a device that is already attached reuses its slot, so a device never
   * carries two adapters; a dropped one is reattached in place and keeps its id.
   */
  connect(): Promise<DgLabDeviceSnapshot> {
    this.pendingConnect ??= this.connectOnce().finally(() => {
      this.pendingConnect = null;
    });
    return this.pendingConnect;
  }

  /** Stops the device first, then drops the link. A later pick gets a fresh id. */
  async disconnect(id: string): Promise<void> {
    const device = this.byId(id);
    if (!device) return;
    try {
      await device.disconnect();
    } finally {
      this.remove(device);
    }
  }

  /** Every Coyote and Opossum, no lease check; one failure does not skip the rest. */
  async stopAll(): Promise<DgLabStopAllResult> {
    const outputs = this.devices.filter((device) => device.outputs);
    // Called synchronously so every queue's generation bumps before this returns control; the
    // try turns a synchronous throw into a rejection instead of skipping the remaining devices.
    const results = await Promise.allSettled(
      outputs.map((device) => {
        try {
          return device.emergencyStop();
        } catch (error) {
          return Promise.reject(error);
        }
      }),
    );
    return {
      attempted: outputs.length,
      failed: results.flatMap((result, index) =>
        result.status === 'rejected' ? [{ id: outputs[index]!.id, error: result.reason }] : [],
      ),
    };
  }

  forModule(moduleId: string): DgLabModuleHandle {
    return {
      moduleId,
      list: () => this.list(),
      subscribe: (listener) => this.subscribe(listener),
      connect: () => this.connect(),
      disconnect: (id) => this.disconnect(id),
      execute: async (id, command) => {
        const device = this.requireDevice(id);
        const fence = isCoyoteStop(command) ? null : this.admit(moduleId);
        return device.executeCoyote(command, fence);
      },
      executeOpossum: async (id, command) => {
        const device = this.requireDevice(id);
        const fence = command.type === 'vibrateStop' ? null : this.admit(moduleId);
        return device.executeOpossum(command, fence);
      },
      setIndicatorColor: async (id, color) => {
        const device = this.requireDevice(id);
        return device.setIndicatorColor(color, this.admit(moduleId));
      },
      emergencyStop: async (id) => {
        if (id === undefined) {
          const result = await this.stopAll();
          if (result.failed[0]) throw result.failed[0].error;
          return;
        }
        await this.requireDevice(id).emergencyStop();
      },
      readings: (id, listener) => this.byId(id)?.readings(listener) ?? (() => undefined),
      onRevoked: (listener) => {
        let set = this.revokedListeners.get(moduleId);
        if (!set) {
          set = new Set();
          this.revokedListeners.set(moduleId, set);
        }
        set.add(listener);
        return () => set.delete(listener);
      },
    };
  }

  /** Stop output, then release every link and the safety session. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeLease();
    const devices = [...this.devices];
    await Promise.allSettled(devices.map((device) => device.disconnect()));
    for (const device of devices) this.remove(device);
    this.unregisterSession();
  }

  private async connectOnce(): Promise<DgLabDeviceSnapshot> {
    const { kind, device, server } = await this.transport.requestDevice();
    const existing = this.findAttached(device);

    if (existing) {
      // Same object or address but a different kind: refuse rather than build a second adapter.
      if (existing.kind !== kind) throw new Error('设备类型与已连接的设备不一致');
      // Never disconnect GATT here: the picker returned the live link the slot already owns.
      if (existing.connected) return existing.snapshot();
      await existing.attach(device, server);
      return existing.snapshot();
    }

    const physical = new PhysicalDgLabDevice(this.nextId(kind), kind, device, this.transport, {
      leaseSnapshot: currentDeviceLeaseSnapshot,
      limits: this.limits,
      onChange: () => this.emit(),
    });
    this.devices.push(physical);
    try {
      await physical.attach(device, server);
    } catch (error) {
      this.remove(physical);
      if (device.gatt?.connected) device.gatt.disconnect();
      throw error;
    }
    return physical.snapshot();
  }

  /** Same device object, or the same non-empty transport address. Never by name. */
  private findAttached(device: BluetoothDeviceLike): PhysicalDgLabDevice | undefined {
    return (
      this.devices.find((candidate) => candidate.source === device) ??
      (device.id ? this.devices.find((candidate) => candidate.source.id === device.id) : undefined)
    );
  }

  private nextId(kind: string): string {
    const used = new Set(this.devices.map((device) => device.id));
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const id = this.createId(kind).trim();
      if (id && !used.has(id)) return id;
    }
    throw new Error('无法分配唯一设备目标身份');
  }

  private admit(moduleId: string): LeaseFence {
    const admission = admitUnderLease(moduleId, currentDeviceLeaseSnapshot());
    if (!admission.ok) throw new DgLabCommandRejectedError(admission.reason);
    return admission.fence;
  }

  private byId(id: string): PhysicalDgLabDevice | undefined {
    return this.devices.find((device) => device.id === id);
  }

  private requireDevice(id: string): PhysicalDgLabDevice {
    const device = this.byId(id);
    if (!device) throw new DgLabCommandRejectedError('unknown-device');
    return device;
  }

  private remove(device: PhysicalDgLabDevice): void {
    const index = this.devices.indexOf(device);
    if (index < 0) return;
    this.devices.splice(index, 1);
    device.dispose();
    this.emit();
  }

  /**
   * Any epoch change stops every output device, then tells the losing module. The link stays
   * up: surrendering control is not disconnecting, and a dropped link would let an
   * auto-reconnecting client race the new holder.
   */
  private onSafetyBusChange(): void {
    const next = currentDeviceLeaseSnapshot();
    if (next.epoch === this.lease.epoch) return;
    const losing = this.lease.holder;
    this.lease = next;
    // stopAll() has already interrupted every queue synchronously; the loser hears about it now
    // so it can drop held aggregate state before its next event arrives.
    void this.stopAll();
    if (losing !== null) this.notifyRevoked(losing);
  }

  private notifyRevoked(moduleId: string): void {
    for (const listener of [...(this.revokedListeners.get(moduleId) ?? [])]) {
      try {
        listener();
      } catch {
        // One module's revoke hook must not hide another's.
      }
    }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

function isCoyoteStop(command: DeviceCommand): boolean {
  return command.type === 'stop' || command.type === 'emergencyStop';
}

function toDeviceSummary(device: PhysicalDgLabDevice, limits: HolderSafetyLimits): DeviceSummary {
  const snapshot = device.snapshot();
  const summary: DeviceSummary = {
    id: snapshot.id,
    kind: snapshot.kind,
    name: snapshot.name,
    connected: snapshot.connected,
    ...(snapshot.connected && typeof snapshot.state.battery === 'number'
      ? { battery: snapshot.state.battery }
      : {}),
  };
  if (snapshot.kind === 'coyote') {
    const { state } = snapshot;
    return {
      ...summary,
      active: isCoyoteOutputActive(state),
      channels: [
        { label: 'A', value: state.strengthA, max: Math.min(state.limitA, limits.maxStrengthA) },
        { label: 'B', value: state.strengthB, max: Math.min(state.limitB, limits.maxStrengthB) },
      ],
    };
  }
  if (snapshot.kind === 'opossum') {
    const { state } = snapshot;
    return {
      ...summary,
      active: state.intensityA > 0 || state.intensityB > 0,
      channels: [
        { label: 'A', value: state.intensityA, max: limits.maxIntensityA },
        { label: 'B', value: state.intensityB, max: limits.maxIntensityB },
      ],
    };
  }
  return summary;
}
