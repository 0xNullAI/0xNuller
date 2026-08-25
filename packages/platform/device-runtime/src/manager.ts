import {
  DEVICE_RUNTIME_SCHEMA_VERSION,
  type BackendCapability,
  type BackendDevice,
  type BackendSessionId,
  type DeviceBackend,
  type DeviceBackendSession,
  type DeviceCapability,
  type DeviceId,
  type DeviceSnapshot,
  type FeatureId,
  type RuntimeDevice,
  type RuntimeEvent,
} from './contracts.js';
import { parseBackendEvent } from './schemas.js';

interface CapabilityRecord {
  featureId: FeatureId;
  nativeFeatureId: string;
  capability: BackendCapability;
  faulted: boolean;
}

interface DeviceRecord {
  deviceId: DeviceId;
  nativeDeviceId: string;
  name: string;
  capabilities: Map<string, CapabilityRecord>;
}

export interface VibrateTarget {
  deviceId: DeviceId;
  featureId: FeatureId;
  nativeDeviceId: string;
  nativeFeatureId: string;
  stepCount: number;
  faulted: boolean;
}

export interface DeviceRuntimeManagerOptions {
  idFactory?: () => string;
}

type ManagerState = 'new' | 'opening' | 'open' | 'ended' | 'closed';

function randomId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

/** Owns exactly one backend session and never reconnects it implicitly. */
export class DeviceRuntimeManager {
  readonly sessionId: BackendSessionId;

  private state: ManagerState = 'new';
  private session: DeviceBackendSession | null = null;
  private topologyGeneration = 0;
  private safetyGeneration = 0;
  private sequence = 0;
  private nextDeviceId = 1;
  private nextFeatureId = 1;
  private devices = new Map<string, DeviceRecord>();
  private readonly snapshotListeners = new Set<(snapshot: DeviceSnapshot) => void>();
  private readonly eventListeners = new Set<(event: RuntimeEvent) => void>();
  private readonly backendSafetyListeners = new Set<() => void>();
  private readonly backend: DeviceBackend;

  constructor(backend: DeviceBackend, options: DeviceRuntimeManagerOptions = {}) {
    this.backend = backend;
    const seed = options.idFactory?.() ?? randomId();
    if (!seed) throw new Error('Device runtime session id must not be empty');
    this.sessionId = `device-session/${seed}` as BackendSessionId;
  }

  async start(): Promise<DeviceSnapshot> {
    if (this.state !== 'new') throw new Error('Device backend session can only be opened once');
    this.state = 'opening';
    try {
      const session = await this.backend.openSession((event) => this.acceptBackendEvent(event));
      if (this.hasTerminalBackendState()) {
        // The backend may report terminal loss while openSession is resolving.
        await session.close();
        return this.snapshot();
      }
      if (this.state !== 'opening') {
        await session.close();
        throw new Error('Device backend session closed while opening');
      }
      this.session = session;
      this.state = 'open';
      return this.snapshot();
    } catch (error) {
      this.state = 'closed';
      this.session = null;
      throw error;
    }
  }

  /** Backend adapters feed only versioned, strictly validated events here. */
  acceptBackendEvent(input: unknown): void {
    if (this.state === 'closed' || this.state === 'ended') return;
    const event = parseBackendEvent(input);
    if (event.type === 'session-ended') {
      const endedSession = this.session;
      this.state = 'ended';
      this.session = null;
      void endedSession?.close();
      this.devices.clear();
      this.topologyGeneration += 1;
      this.safetyGeneration += 1;
      for (const listener of this.backendSafetyListeners) {
        try {
          listener();
        } catch {
          // The terminal fence remains active even if an observer fails.
        }
      }
      this.publishSnapshot();
      return;
    }
    this.replaceTopology(event.devices);
  }

  snapshot(): DeviceSnapshot {
    const devices: RuntimeDevice[] = [];
    for (const device of this.devices.values()) {
      const capabilities: DeviceCapability[] = [];
      for (const record of device.capabilities.values()) {
        const capability = record.capability;
        if (capability.kind === 'vibrate') {
          capabilities.push({
            kind: 'vibrate',
            featureId: record.featureId,
            stepCount: capability.stepCount,
            faulted: record.faulted,
          });
        } else {
          capabilities.push({
            kind: capability.kind,
            featureId: record.featureId,
            value: capability.value,
          });
        }
      }
      devices.push({ deviceId: device.deviceId, name: device.name, capabilities });
    }
    return {
      version: DEVICE_RUNTIME_SCHEMA_VERSION,
      sessionId: this.sessionId,
      sequence: this.sequence,
      topologyGeneration: this.topologyGeneration,
      safetyGeneration: this.safetyGeneration,
      devices,
    };
  }

  subscribe(listener: (snapshot: DeviceSnapshot) => void): () => void {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  subscribeEvents(listener: (event: RuntimeEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Structural backend changes synchronously fence output before observers can act. */
  subscribeBackendSafetyTransitions(listener: () => void): () => void {
    this.backendSafetyListeners.add(listener);
    return () => this.backendSafetyListeners.delete(listener);
  }

  advanceSafetyGeneration(): number {
    this.safetyGeneration += 1;
    this.publishSnapshot();
    return this.safetyGeneration;
  }

  resolveVibrateTarget(deviceId: DeviceId, featureId: FeatureId): VibrateTarget | null {
    for (const device of this.devices.values()) {
      if (device.deviceId !== deviceId) continue;
      for (const record of device.capabilities.values()) {
        if (record.featureId !== featureId || record.capability.kind !== 'vibrate') continue;
        return {
          deviceId,
          featureId,
          nativeDeviceId: device.nativeDeviceId,
          nativeFeatureId: record.nativeFeatureId,
          stepCount: record.capability.stepCount,
          faulted: record.faulted,
        };
      }
    }
    return null;
  }

  resolveDevice(deviceId: DeviceId): { nativeDeviceId: string; vibrate: VibrateTarget[] } | null {
    for (const device of this.devices.values()) {
      if (device.deviceId !== deviceId) continue;
      const vibrate: VibrateTarget[] = [];
      for (const record of device.capabilities.values()) {
        if (record.capability.kind === 'vibrate') {
          vibrate.push({
            deviceId,
            featureId: record.featureId,
            nativeDeviceId: device.nativeDeviceId,
            nativeFeatureId: record.nativeFeatureId,
            stepCount: record.capability.stepCount,
            faulted: record.faulted,
          });
        }
      }
      return { nativeDeviceId: device.nativeDeviceId, vibrate };
    }
    return null;
  }

  allVibrateTargets(): VibrateTarget[] {
    return this.snapshot().devices.flatMap((device) =>
      device.capabilities.flatMap((capability) => {
        if (capability.kind !== 'vibrate') return [];
        const target = this.resolveVibrateTarget(device.deviceId, capability.featureId);
        return target ? [target] : [];
      }),
    );
  }

  async scan(): Promise<void> {
    await this.requireSession().scan();
  }

  async disconnect(deviceId: DeviceId): Promise<void> {
    const resolved = this.resolveDevice(deviceId);
    if (!resolved) throw new Error('unknown-device');
    await this.requireSession().disconnect(resolved.nativeDeviceId);
    this.removeNativeDevice(resolved.nativeDeviceId);
  }

  async writeVibrate(target: VibrateTarget, intensity: number): Promise<void> {
    await this.requireSession().writeVibrate(
      target.nativeDeviceId,
      target.nativeFeatureId,
      intensity,
    );
  }

  async stopFeature(target: VibrateTarget): Promise<void> {
    await this.requireSession().stopFeature(target.nativeDeviceId, target.nativeFeatureId);
  }

  async stopAll(): Promise<void> {
    await this.requireSession().stopAll();
  }

  latchStopFault(target: Pick<VibrateTarget, 'deviceId' | 'featureId'>): void {
    const resolved = this.findCapability(target.deviceId, target.featureId);
    if (!resolved || resolved.record.capability.kind !== 'vibrate' || resolved.record.faulted)
      return;
    resolved.record.faulted = true;
    this.sequence += 1;
    const fault: RuntimeEvent = {
      version: DEVICE_RUNTIME_SCHEMA_VERSION,
      type: 'fault',
      sessionId: this.sessionId,
      deviceId: target.deviceId,
      featureId: target.featureId,
      code: 'stop-failed',
      hardwareState: 'unknown',
    };
    for (const listener of this.eventListeners) {
      try {
        listener(fault);
      } catch {
        // Observers cannot be allowed to interrupt a safety transition.
      }
    }
    this.emitSnapshot();
  }

  async close(): Promise<void> {
    if (this.state === 'closed') return;
    const session = this.session;
    this.advanceSafetyGeneration();
    let stopError: unknown;
    if (session) {
      try {
        await session.stopAll();
      } catch (error) {
        stopError = error;
        for (const target of this.allVibrateTargets()) this.latchStopFault(target);
      }
      try {
        await session.close();
      } finally {
        this.state = 'closed';
        this.session = null;
        this.devices.clear();
        this.topologyGeneration += 1;
        this.publishSnapshot();
      }
    } else {
      this.state = 'closed';
      this.devices.clear();
      this.topologyGeneration += 1;
      this.publishSnapshot();
    }
    if (stopError) throw stopError;
  }

  private hasTerminalBackendState(): boolean {
    // Kept behind a method because openSession's callback can mutate state
    // while its promise is pending; TypeScript cannot observe that effect.
    return this.state === 'ended';
  }

  private requireSession(): DeviceBackendSession {
    if (this.state !== 'open' || !this.session) throw new Error('backend-session-unavailable');
    return this.session;
  }

  private replaceTopology(incoming: readonly BackendDevice[]): void {
    const structuralChange = !this.hasSameTopology(incoming);
    const next = new Map<string, DeviceRecord>();
    for (const backendDevice of incoming) {
      const previous = this.devices.get(backendDevice.nativeDeviceId);
      const device: DeviceRecord = previous ?? {
        deviceId: `${this.sessionId}/device/${this.nextDeviceId++}` as DeviceId,
        nativeDeviceId: backendDevice.nativeDeviceId,
        name: backendDevice.name,
        capabilities: new Map(),
      };
      device.name = backendDevice.name;
      const capabilities = new Map<string, CapabilityRecord>();
      for (const incomingCapability of backendDevice.capabilities) {
        const previousCapability = device.capabilities.get(incomingCapability.nativeFeatureId);
        const sameKind = previousCapability?.capability.kind === incomingCapability.kind;
        capabilities.set(incomingCapability.nativeFeatureId, {
          featureId:
            previousCapability && sameKind
              ? previousCapability.featureId
              : (`${this.sessionId}/feature/${this.nextFeatureId++}` as FeatureId),
          nativeFeatureId: incomingCapability.nativeFeatureId,
          capability: { ...incomingCapability },
          faulted: previousCapability && sameKind ? previousCapability.faulted : false,
        });
      }
      device.capabilities = capabilities;
      next.set(backendDevice.nativeDeviceId, device);
    }
    this.devices = next;
    if (structuralChange) {
      this.topologyGeneration += 1;
      this.safetyGeneration += 1;
      for (const listener of this.backendSafetyListeners) {
        try {
          listener();
        } catch {
          // A safety observer cannot prevent the topology fence from publishing.
        }
      }
      this.publishSnapshot();
    } else {
      // Battery/RSSI refreshes are observable state, not a topology or safety epoch.
      this.sequence += 1;
      this.emitSnapshot();
    }
  }

  private hasSameTopology(incoming: readonly BackendDevice[]): boolean {
    if (incoming.length !== this.devices.size) return false;
    for (const backendDevice of incoming) {
      const current = this.devices.get(backendDevice.nativeDeviceId);
      if (!current || current.capabilities.size !== backendDevice.capabilities.length) return false;
      for (const capability of backendDevice.capabilities) {
        const previous = current.capabilities.get(capability.nativeFeatureId)?.capability;
        if (!previous || previous.kind !== capability.kind) return false;
        if (
          previous.kind === 'vibrate' &&
          capability.kind === 'vibrate' &&
          previous.stepCount !== capability.stepCount
        ) {
          return false;
        }
      }
    }
    return true;
  }

  private removeNativeDevice(nativeDeviceId: string): void {
    if (!this.devices.delete(nativeDeviceId)) return;
    this.topologyGeneration += 1;
    this.safetyGeneration += 1;
    this.publishSnapshot();
  }

  private findCapability(
    deviceId: DeviceId,
    featureId: FeatureId,
  ): { device: DeviceRecord; record: CapabilityRecord } | null {
    for (const device of this.devices.values()) {
      if (device.deviceId !== deviceId) continue;
      for (const record of device.capabilities.values()) {
        if (record.featureId === featureId) return { device, record };
      }
    }
    return null;
  }

  private publishSnapshot(): void {
    this.sequence += 1;
    this.emitSnapshot();
  }

  private emitSnapshot(): void {
    const snapshot = this.snapshot();
    for (const listener of this.snapshotListeners) {
      try {
        listener(snapshot);
      } catch {
        // Preserve ordered delivery to the remaining observers.
      }
    }
    const event: RuntimeEvent = {
      version: DEVICE_RUNTIME_SCHEMA_VERSION,
      type: 'snapshot',
      snapshot,
    };
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // Preserve ordered delivery to the remaining observers.
      }
    }
  }
}
