import {
  DEVICE_KIND_DISPLAY_NAME,
  isCoyoteOutputActive,
  type DeviceCommand,
  type DeviceKind,
  type OpossumCommand,
} from '@dg-kit/core';
import type { BluetoothDeviceLike } from '@dg-kit/protocol';
import {
  currentDeviceLeaseSnapshot,
  registerSafetySession,
  subscribeSafetySessions,
  type DeviceLeaseSnapshot,
  type DeviceSummary,
} from '@dg-kit/safety';
import type { DeviceOwnLimits } from '@0xnullai/settings';
import {
  deriveDgLabStableKey,
  settingsDeviceLimitStore,
  type DgLabChannelLimits,
  type DgLabDeviceLimitStore,
} from './device-limits.js';
import type { DgLabTransport } from './dglab-transport.js';
import {
  applyDeviceOwnLimits,
  holderChannelLimits,
  type HolderSafetyLimits,
} from './holder-limits.js';
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
  /** Global per-type caps. Read at every write, so a lowered setting applies to queued work. */
  limits: () => HolderSafetyLimits;
  /**
   * Fires when the global caps change. The registry then stops any device whose output is now
   * above its cap, exactly as it does for a lowered per-device limit.
   */
  subscribeLimits?: (listener: () => void) => () => void;
  /** Per-device limits by stable key. Defaults to the app's local settings store. */
  deviceLimits?: DgLabDeviceLimitStore;
  /** Opaque target id factory. Retried on collision. */
  createId?: (kind: string) => string;
  label?: string;
}

export type DgLabOutputKind = 'coyote' | 'opossum';

/** One output device's limits, as the settings page lists them. */
export interface DgLabDeviceLimitEntry {
  /** Opaque, survives reconnects. Never a raw address. */
  stableKey: string;
  kind: DgLabOutputKind;
  name: string;
  /** The current connection's target id; null for a remembered device that is not attached. */
  id: string | null;
  connected: boolean;
  /** Null while unknown or disconnected. */
  battery: number | null;
  /** This device's own caps (200 = no extra restriction). */
  ownLimits: DgLabChannelLimits;
  /** The global caps for this kind of device. */
  globalLimits: DgLabChannelLimits;
  /** What the holder enforces: `min(global, own)`, and for a Coyote also its hardware limit. */
  effectiveLimits: DgLabChannelLimits;
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
  private readonly deviceLimits: DgLabDeviceLimitStore;
  private readonly unsubscribeLimits: () => void;
  private readonly createId: (kind: string) => string;
  private readonly devices: PhysicalDgLabDevice[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly revokedListeners = new Map<string, Set<() => void>>();
  private readonly unregisterSession: () => void;
  private readonly unsubscribeLease: () => void;
  private lease: DeviceLeaseSnapshot = currentDeviceLeaseSnapshot();
  private pendingConnect: Promise<DgLabDeviceSnapshot> | null = null;
  private limitChanges = 0;
  private limitEnforcement: Promise<void> = Promise.resolve();
  /** Each output device's caps as of the last limit change, to tell a lowering from noise. */
  private readonly appliedCaps = new WeakMap<PhysicalDgLabDevice, DgLabChannelLimits>();
  private disposed = false;

  constructor(options: DgLabConnectionRegistryOptions) {
    this.transport = options.transport;
    this.limits = options.limits;
    this.deviceLimits = options.deviceLimits ?? settingsDeviceLimitStore;
    this.createId = options.createId ?? ((kind) => `${kind}/${crypto.randomUUID()}`);

    this.unregisterSession = registerSafetySession({
      id: DGLAB_SAFETY_SESSION_ID,
      label: options.label ?? 'DG-Lab 设备',
      isActive: () => this.devices.some((device) => device.connected),
      stop: async () => {
        await this.stopAll();
      },
      devices: () => this.devices.map((device) => toDeviceSummary(device)),
      connect: () => this.connect(),
      disconnect: (id) => this.disconnect(id),
    });
    this.unsubscribeLease = subscribeSafetySessions(() => this.onSafetyBusChange());
    const offOwn = this.deviceLimits.subscribe(() => this.onLimitsChanged());
    const offGlobal = options.subscribeLimits?.(() => this.onLimitsChanged()) ?? (() => undefined);
    this.unsubscribeLimits = () => {
      offOwn();
      offGlobal();
    };
  }

  /**
   * Every connected Coyote and Opossum, then every remembered one that is not attached. For the
   * settings page: no lease is needed to read or change limits.
   */
  listDeviceLimits(): DgLabDeviceLimitEntry[] {
    const records = this.loadOwnRecords();
    const global = this.limits();
    const entries: DgLabDeviceLimitEntry[] = [];
    const seen = new Set<string>();
    for (const device of this.devices) {
      if (!isOutputKind(device.kind) || seen.has(device.stableKey)) continue;
      const snapshot = device.snapshot();
      if (snapshot.kind !== 'coyote' && snapshot.kind !== 'opossum') continue;
      seen.add(device.stableKey);
      const own = ownLimitsOf(records[device.stableKey], device.kind);
      entries.push({
        stableKey: device.stableKey,
        kind: device.kind,
        name: displayName(snapshot.name, device.kind),
        id: device.id,
        connected: snapshot.connected,
        battery:
          snapshot.connected && typeof snapshot.state.battery === 'number'
            ? snapshot.state.battery
            : null,
        ownLimits: own ?? { a: DEFAULT_OWN_LIMIT, b: DEFAULT_OWN_LIMIT },
        globalLimits: holderChannelLimits(global, device.kind),
        effectiveLimits:
          snapshot.kind === 'coyote'
            ? { a: snapshot.state.limitA, b: snapshot.state.limitB }
            : snapshot.limits,
      });
    }
    for (const [stableKey, record] of Object.entries(records)) {
      if (seen.has(stableKey)) continue;
      const own = { a: record.a, b: record.b };
      entries.push({
        stableKey,
        kind: record.kind,
        name: displayName(record.name, record.kind),
        id: null,
        connected: false,
        battery: null,
        ownLimits: own,
        globalLimits: holderChannelLimits(global, record.kind),
        effectiveLimits: holderChannelLimits(
          applyDeviceOwnLimits(global, record.kind, own),
          record.kind,
        ),
      });
    }
    return entries;
  }

  /** Fires on topology, device state, and any global or per-device limit change. */
  subscribeDeviceLimits(listener: () => void): () => void {
    return this.subscribe(listener);
  }

  /**
   * Set one device's own caps. `target` is its current connection id or its stable key (a
   * remembered device need not be attached). Omitted channels keep their value. Needs no
   * lease: it only changes caps, and a cap lowered below the running output stops that device
   * before this resolves. Rejects if that stop failed (the new cap is saved either way).
   */
  async setOwnLimits(
    target: string,
    limits: Partial<DgLabChannelLimits>,
  ): Promise<DgLabDeviceLimitEntry> {
    const resolved = this.resolveLimitTarget(target);
    if (!resolved) throw new DgLabCommandRejectedError('unknown-device');
    const before = this.limitChanges;
    this.deviceLimits.update(resolved.stableKey, {
      kind: resolved.kind,
      ...(typeof limits.a === 'number' ? { a: limits.a } : {}),
      ...(typeof limits.b === 'number' ? { b: limits.b } : {}),
      ...(resolved.name ? { name: resolved.name } : {}),
    });
    // The store notifies synchronously, which already issued any stop. A store that did not
    // notify (or an unchanged value) still gets one enforcement pass here.
    if (this.limitChanges === before) this.onLimitsChanged();
    await this.limitEnforcement;
    const entry = this.listDeviceLimits().find((item) => item.stableKey === resolved.stableKey);
    if (!entry) throw new DgLabCommandRejectedError('unknown-device');
    return entry;
  }

  /**
   * Forget a device's own caps. An attached device stays listed with no extra cap (it is
   * re-remembered); a detached one disappears from the list.
   */
  forgetDeviceLimits(stableKey: string): void {
    this.deviceLimits.remove(stableKey);
    const attached = this.devices.find((device) => device.stableKey === stableKey);
    if (attached) this.remember(attached);
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
    this.unsubscribeLimits();
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
      this.trackCaps(existing);
      this.remember(existing);
      return existing.snapshot();
    }

    const stableKey = deriveDgLabStableKey(kind, device);
    const physical = new PhysicalDgLabDevice(this.nextId(kind), kind, device, this.transport, {
      leaseSnapshot: currentDeviceLeaseSnapshot,
      limits: () => this.limitsFor(kind, stableKey),
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
    this.trackCaps(physical);
    this.remember(physical);
    return physical.snapshot();
  }

  /** Global caps lowered by this device's own record, read fresh at every call. */
  private limitsFor(kind: DeviceKind, stableKey: string): HolderSafetyLimits {
    const global = this.limits();
    if (!isOutputKind(kind)) return global;
    return applyDeviceOwnLimits(global, kind, ownLimitsOf(this.loadOwnRecords()[stableKey], kind));
  }

  private loadOwnRecords(): Record<string, DeviceOwnLimits> {
    try {
      return this.deviceLimits.load();
    } catch {
      // An unreadable store falls back to the global caps alone; it never blocks a stop.
      return {};
    }
  }

  private trackCaps(device: PhysicalDgLabDevice): void {
    const caps = outputCaps(device);
    if (caps) this.appliedCaps.set(device, caps);
  }

  /** Remember an attached output device so its caps can be set while it is away. */
  private remember(device: PhysicalDgLabDevice): void {
    if (!isOutputKind(device.kind)) return;
    try {
      this.deviceLimits.update(device.stableKey, {
        kind: device.kind,
        name: displayName(device.snapshot().name, device.kind),
      });
    } catch {
      // Remembering is a convenience; a failed write must not fail the connection.
    }
  }

  private resolveLimitTarget(
    target: string,
  ): { stableKey: string; kind: DgLabOutputKind; name?: string } | null {
    const attached =
      this.byId(target) ?? this.devices.find((device) => device.stableKey === target);
    if (attached) {
      if (!isOutputKind(attached.kind)) return null;
      return {
        stableKey: attached.stableKey,
        kind: attached.kind,
        name: displayName(attached.snapshot().name, attached.kind),
      };
    }
    const record = this.loadOwnRecords()[target];
    return record ? { stableKey: target, kind: record.kind } : null;
  }

  private onLimitsChanged(): void {
    this.limitChanges += 1;
    const enforcement = this.enforceLimits();
    this.limitEnforcement = enforcement;
    enforcement.catch(() => undefined);
    this.emit();
  }

  /**
   * Stop every output device whose cap was just lowered below its running output. Stops are
   * issued synchronously (each queue's generation bumps before this returns control), so work
   * queued before the change is skipped; later writes are re-clamped under the new cap. Output
   * that was already above an unchanged cap (a Coyote's own wheel, for example) is left to the
   * write-time clamp rather than stopped by an unrelated settings change.
   */
  private enforceLimits(): Promise<void> {
    const over = this.devices.filter((device) => {
      const caps = outputCaps(device);
      if (!caps) return false;
      const previous = this.appliedCaps.get(device);
      this.appliedCaps.set(device, caps);
      const lowered = !previous || caps.a < previous.a || caps.b < previous.b;
      return lowered && device.connected && outputAboveCap(device);
    });
    const stops = over.map((device) => {
      try {
        return device.emergencyStop();
      } catch (error) {
        return Promise.reject(error);
      }
    });
    return Promise.allSettled(stops).then((results) => {
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failure) throw failure.reason;
    });
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

const DEFAULT_OWN_LIMIT = 200;
const MAC_ADDRESS = /([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i;

function isOutputKind(kind: DeviceKind): kind is DgLabOutputKind {
  return kind === 'coyote' || kind === 'opossum';
}

function ownLimitsOf(
  record: DeviceOwnLimits | undefined,
  kind: DgLabOutputKind,
): DgLabChannelLimits | null {
  // A record of the other kind under this key is stale; it neither loosens nor applies.
  return record && record.kind === kind ? { a: record.a, b: record.b } : null;
}

/** A device name for display. A transport that fell back to its address never leaks it. */
function displayName(name: string | undefined, kind: DgLabOutputKind): string {
  const trimmed = name?.trim();
  if (!trimmed || MAC_ADDRESS.test(trimmed)) return DEVICE_KIND_DISPLAY_NAME[kind];
  return trimmed;
}

/** The caps the holder enforces on an output device: for a Coyote, its folded soft limit. */
function outputCaps(device: PhysicalDgLabDevice): DgLabChannelLimits | null {
  const snapshot = device.snapshot();
  if (snapshot.kind === 'coyote') return { a: snapshot.state.limitA, b: snapshot.state.limitB };
  if (snapshot.kind === 'opossum') return snapshot.limits;
  return null;
}

function outputAboveCap(device: PhysicalDgLabDevice): boolean {
  const snapshot = device.snapshot();
  if (snapshot.kind === 'coyote') {
    const { state } = snapshot;
    return state.strengthA > state.limitA || state.strengthB > state.limitB;
  }
  if (snapshot.kind === 'opossum') {
    const { state, limits } = snapshot;
    return state.intensityA > limits.a || state.intensityB > limits.b;
  }
  return false;
}

function toDeviceSummary(device: PhysicalDgLabDevice): DeviceSummary {
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
        // The snapshot's soft limit already folds in the global and per-device caps.
        { label: 'A', value: state.strengthA, max: state.limitA },
        { label: 'B', value: state.strengthB, max: state.limitB },
      ],
    };
  }
  if (snapshot.kind === 'opossum') {
    const { state } = snapshot;
    return {
      ...summary,
      active: state.intensityA > 0 || state.intensityB > 0,
      channels: [
        { label: 'A', value: state.intensityA, max: snapshot.limits.a },
        { label: 'B', value: state.intensityB, max: snapshot.limits.b },
      ],
    };
  }
  return summary;
}
