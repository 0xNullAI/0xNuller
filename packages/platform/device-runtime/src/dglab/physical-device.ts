import {
  createEmptyDeviceState,
  createEmptySensorState,
  DEVICE_KIND_DISPLAY_NAME,
  type DeviceCommand,
  type DeviceCommandResult,
  type DeviceKind,
  type DeviceState,
  type OpossumCommand,
  type SensorState,
} from '@dg-kit/core';
import {
  CoyoteProtocolAdapter,
  createEmptyOpossumState,
  type BluetoothDeviceLike,
  type BluetoothRemoteGATTServerLike,
  type OpossumButtonEvent,
  type OpossumCommandResult,
  type OpossumState,
} from '@dg-kit/protocol';
import { SerialCommandQueue, type DeviceLeaseSnapshot } from '@dg-kit/safety';
import type {
  DgLabCoyoteClient,
  DgLabOpossumClient,
  DgLabSensorClient,
  DgLabSensorKind,
  DgLabSensorReading,
  DgLabTransport,
} from './dglab-transport.js';
import { deriveDgLabStableKey, type DgLabChannelLimits } from './device-limits.js';
import {
  clampCoyoteCommandToHolderLimits,
  clampOpossumCommandToHolderLimits,
  holderChannelLimits,
  type HolderSafetyLimits,
} from './holder-limits.js';
import { checkLeaseFence, type LeaseFence } from './lease-fence.js';

export type DgLabRejectCode =
  | 'lease-not-held'
  | 'lease-changed'
  | 'unknown-device'
  | 'wrong-kind'
  | 'disconnected'
  | 'limit-denied';

/** A write the holder refused. Nothing reached the device. */
export class DgLabCommandRejectedError extends Error {
  readonly code: DgLabRejectCode;

  constructor(code: DgLabRejectCode, message: string = code) {
    super(message);
    this.name = 'DgLabCommandRejectedError';
    this.code = code;
  }
}

export type DgLabReading = DgLabSensorReading | OpossumButtonEvent;

interface DgLabSnapshotBase {
  /** Opaque per-connection target id. A new pick of the same device gets a new one. */
  id: string;
  /** Opaque key that survives reconnects and restarts; only for remembered settings. */
  stableKey: string;
  name: string;
  connected: boolean;
}

/**
 * For output devices, `limits` is what the holder enforces on this device right now:
 * `min(global type cap, the device's own cap)`. A Coyote's `state.limitA/limitB` already
 * include it, so every reader of the device's soft limit sees the same number.
 */
export type DgLabDeviceSnapshot =
  | (DgLabSnapshotBase & { kind: 'coyote'; state: DeviceState; limits: DgLabChannelLimits })
  | (DgLabSnapshotBase & { kind: 'opossum'; state: OpossumState; limits: DgLabChannelLimits })
  | (DgLabSnapshotBase & { kind: DgLabSensorKind; state: SensorState });

export type CoyoteWriteResult = DeviceCommandResult & { interrupted?: true };
export type OpossumWriteResult = OpossumCommandResult & { interrupted?: true };

export interface PhysicalDeviceDeps {
  leaseSnapshot: () => DeviceLeaseSnapshot;
  /** This device's caps (global, lowered by its own limits). Read at every write. */
  limits: () => HolderSafetyLimits;
  onChange: () => void;
}

/**
 * Every queued write is a fence plus a two-phase body: `prepare` may await (fresh device state,
 * re-clamp) and returns the synchronous-start write. The fence is re-checked between the two, so
 * no await separates the last lease check from the native write.
 */
interface FencedTask {
  fence: LeaseFence | null;
  prepare(): Promise<() => Promise<unknown>>;
}

const SKIPPED: unique symbol = Symbol('skipped-after-priority-interrupt');
const STOPPED: unique symbol = Symbol('stopped');

type Clients =
  | { kind: 'coyote'; client: DgLabCoyoteClient }
  | { kind: 'opossum'; client: DgLabOpossumClient }
  | { kind: DgLabSensorKind; client: DgLabSensorClient };

/**
 * One physical DG-Lab device: one protocol adapter, one transport client, one fenced serial
 * queue. Modules never see this object; they reach it only through the registry's handle.
 */
export class PhysicalDgLabDevice {
  readonly id: string;
  readonly kind: DeviceKind;
  /** The picked device object. Identity (with its address) is how reconnects find this slot. */
  readonly source: BluetoothDeviceLike;
  /** Derived once from the picked device; see `deriveDgLabStableKey`. */
  readonly stableKey: string;
  private readonly clients: Clients;
  private readonly deps: PhysicalDeviceDeps;
  private readonly queue: SerialCommandQueue<FencedTask, unknown>;
  private readonly unsubscribeState: () => void;
  private state: DeviceState | OpossumState | SensorState;
  private wasConnected = false;

  constructor(
    id: string,
    kind: DeviceKind,
    source: BluetoothDeviceLike,
    transport: DgLabTransport,
    deps: PhysicalDeviceDeps,
  ) {
    this.id = id;
    this.kind = kind;
    this.source = source;
    this.stableKey = deriveDgLabStableKey(kind, source);
    this.deps = deps;
    this.clients = createClients(kind, transport);
    this.state =
      kind === 'coyote'
        ? createEmptyDeviceState()
        : kind === 'opossum'
          ? createEmptyOpossumState()
          : createEmptySensorState();
    this.queue = new SerialCommandQueue<FencedTask, unknown>({ execute: (task) => this.run(task) });
    this.unsubscribeState = this.subscribeClientState();
  }

  get connected(): boolean {
    return this.state.connected;
  }

  /** True for kinds that produce output: every Coyote and Opossum. */
  get outputs(): boolean {
    return this.kind === 'coyote' || this.kind === 'opossum';
  }

  snapshot(): DgLabDeviceSnapshot {
    const name = this.state.deviceName || this.source.name || DEVICE_KIND_DISPLAY_NAME[this.kind];
    const base = { id: this.id, stableKey: this.stableKey, name, connected: this.state.connected };
    if (this.clients.kind === 'coyote') {
      const limits = holderChannelLimits(this.deps.limits(), 'coyote');
      const state = this.state as DeviceState;
      return {
        ...base,
        kind: 'coyote',
        limits,
        state: {
          ...state,
          limitA: Math.min(state.limitA, limits.a),
          limitB: Math.min(state.limitB, limits.b),
        },
      };
    }
    if (this.clients.kind === 'opossum') {
      const limits = holderChannelLimits(this.deps.limits(), 'opossum');
      return { ...base, kind: 'opossum', limits, state: { ...(this.state as OpossumState) } };
    }
    return { ...base, kind: this.clients.kind, state: { ...(this.state as SensorState) } };
  }

  /** Attach (first time or reconnect) and treat it as a new safety boundary: zero output. */
  async attach(device: BluetoothDeviceLike, server: BluetoothRemoteGATTServerLike): Promise<void> {
    await this.clients.client.connectDevice(device, server);
    this.state = await this.clients.client.getState();
    this.wasConnected = this.state.connected;
    // A V3 Coyote retains its last output across a BLE drop; never resume it implicitly.
    await this.emergencyStop();
    this.deps.onChange();
  }

  async executeCoyote(
    command: DeviceCommand,
    fence: LeaseFence | null,
  ): Promise<CoyoteWriteResult> {
    if (this.clients.kind !== 'coyote') throw new DgLabCommandRejectedError('wrong-kind');
    if (command.type === 'emergencyStop') {
      await this.emergencyStop();
      return { state: await this.clients.client.getState(), notes: ['emergency-stop'] };
    }
    const client = this.clients.client;
    const result = await this.queue.enqueue({
      fence,
      prepare: async () => {
        const state = await client.getState();
        if (!state.connected) throw new DgLabCommandRejectedError('disconnected');
        const limited = clampCoyoteCommandToHolderLimits(command, state, this.deps.limits());
        if (!limited.ok) throw new DgLabCommandRejectedError('limit-denied', limited.reason);
        return async () => {
          const written = await client.execute(limited.command);
          return limited.clamped
            ? { ...written, notes: [...(written.notes ?? []), ...limited.reasons] }
            : written;
        };
      },
    });
    if (result === SKIPPED) {
      return {
        state: await client.getState(),
        notes: ['skipped-after-priority-interrupt'],
        interrupted: true,
      };
    }
    return result as CoyoteWriteResult;
  }

  async executeOpossum(
    command: OpossumCommand,
    fence: LeaseFence | null,
  ): Promise<OpossumWriteResult> {
    if (this.clients.kind !== 'opossum') throw new DgLabCommandRejectedError('wrong-kind');
    const client = this.clients.client;
    const result = await this.queue.enqueue({
      fence,
      prepare: async () => {
        const state = await client.getState();
        if (!state.connected) throw new DgLabCommandRejectedError('disconnected');
        const limited = clampOpossumCommandToHolderLimits(command, state, this.deps.limits());
        if (!limited.ok) throw new DgLabCommandRejectedError('limit-denied', limited.reason);
        return () => client.execute(limited.command);
      },
    });
    if (result === SKIPPED) return { state: await client.getState(), interrupted: true };
    return result as OpossumWriteResult;
  }

  /** LED writes share the BLE link, so they are serialized and fenced like output. */
  async setIndicatorColor(color: number, fence: LeaseFence): Promise<void> {
    const clients = this.clients;
    if (clients.kind === 'coyote') throw new DgLabCommandRejectedError('wrong-kind');
    const client: DgLabOpossumClient | DgLabSensorClient = clients.client;
    if (!client.setIndicatorColor) throw new DgLabCommandRejectedError('wrong-kind');
    const setColor = client.setIndicatorColor.bind(client);
    await this.queue.enqueue({
      fence,
      prepare: async () => {
        if (!(await client.getState()).connected) {
          throw new DgLabCommandRejectedError('disconnected');
        }
        return () => setColor(color);
      },
    });
  }

  /**
   * Priority interrupt. No fence, no lease: queued work is skipped and an in-flight write that
   * lands late is followed by another stop (the kit queue's generation guard).
   */
  async emergencyStop(): Promise<void> {
    if (!this.outputs) return;
    await this.queue.interrupt(
      async () => {
        await this.stopNow();
        return STOPPED;
      },
      async () => SKIPPED,
    );
  }

  readings(listener: (reading: DgLabReading) => void): () => void {
    if (this.clients.kind === 'coyote') return () => undefined;
    if (this.clients.kind === 'opossum') {
      return this.clients.client.subscribeButtons?.(listener) ?? (() => undefined);
    }
    return this.clients.client.subscribe(listener);
  }

  /** Stop first, then drop the link. A failed stop does not keep the link open. */
  async disconnect(): Promise<void> {
    try {
      await this.emergencyStop();
    } finally {
      await this.clients.client.disconnect();
    }
  }

  dispose(): void {
    this.unsubscribeState();
  }

  private async run(task: FencedTask): Promise<unknown> {
    const write = await task.prepare();
    if (task.fence) {
      const check = checkLeaseFence(task.fence, this.deps.leaseSnapshot());
      if (!check.ok) throw new DgLabCommandRejectedError(check.reason);
    }
    return write();
  }

  private async stopNow(): Promise<void> {
    if (this.clients.kind === 'coyote' || this.clients.kind === 'opossum') {
      await this.clients.client.emergencyStop();
    }
  }

  private subscribeClientState(): () => void {
    const onState = (state: DeviceState | OpossumState | SensorState) => {
      const reconnected = state.connected && !this.wasConnected;
      this.wasConnected = state.connected;
      this.state = state;
      // A transport-level silent reconnect is also a new link: zero it before anyone writes.
      if (reconnected) void this.emergencyStop().catch(() => undefined);
      this.deps.onChange();
    };
    const { clients } = this;
    if (clients.kind === 'coyote') return clients.client.onStateChanged(onState);
    if (clients.kind === 'opossum') return clients.client.onStateChanged(onState);
    return clients.client.onStateChanged(onState);
  }
}

function createClients(kind: DeviceKind, transport: DgLabTransport): Clients {
  if (kind === 'coyote') {
    // One adapter per physical device: it owns this device's tick loop and stop path.
    return { kind, client: transport.createCoyoteClient(new CoyoteProtocolAdapter()) };
  }
  if (kind === 'opossum') return { kind, client: transport.createOpossumClient() };
  return { kind, client: transport.createSensorClient(kind) };
}
