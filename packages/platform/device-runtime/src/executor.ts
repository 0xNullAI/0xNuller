import {
  DEVICE_RUNTIME_SCHEMA_VERSION,
  MAX_OUTPUT_LEASE_MS,
  type CommandAck,
  type DeviceRuntimeExecutorOptions,
  type DeviceSafetyPolicy,
  type DisconnectCommand,
  type RuntimeCommand,
  type RuntimeEvent,
  type RuntimeFence,
  type ScanCommand,
  type VibrateCommand,
} from './contracts.js';
import type { DeviceRuntimeManager, VibrateTarget } from './manager.js';
import { parseRuntimeCommand } from './schemas.js';

interface FeatureQueue {
  tail: Promise<void>;
}

interface Watchdog {
  handle: unknown;
}

/** Executes validated commands at the final shared boundary before native I/O. */
export class DeviceRuntimeExecutor {
  private readonly queues = new Map<string, FeatureQueue>();
  private readonly outputIntensity = new Map<string, number>();
  private readonly watchdogs = new Map<string, Watchdog>();
  private readonly featureBarriers = new Map<string, number>();
  private globalBarrierDepth = 0;
  private faultLatched = false;
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly options: DeviceRuntimeExecutorOptions;
  private readonly manager: DeviceRuntimeManager;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(manager: DeviceRuntimeManager, options: DeviceRuntimeExecutorOptions) {
    this.manager = manager;
    this.options = options;
    this.setTimer =
      options.setTimer ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((handle) => globalThis.clearTimeout(handle as number));
    manager.subscribeEvents((event) => this.emit(event));
    manager.subscribeBackendSafetyTransitions(() => this.preemptBackendTransition());
  }

  captureFence(moduleId: string): RuntimeFence {
    const snapshot = this.manager.snapshot();
    const lease = this.options.leaseSnapshot();
    return {
      sessionId: snapshot.sessionId,
      topologyGeneration: snapshot.topologyGeneration,
      safetyGeneration: snapshot.safetyGeneration,
      moduleId,
      leaseEpoch: lease.epoch,
    };
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async execute(input: unknown): Promise<CommandAck> {
    const command = parseRuntimeCommand(input);
    let ack: CommandAck;
    switch (command.type) {
      case 'stop':
        ack = await this.executeStop(command);
        break;
      case 'emergency-stop':
        ack = await this.executeEmergencyStop(command.interactionId);
        break;
      case 'scan':
        ack = await this.executeScan(command);
        break;
      case 'disconnect':
        ack = await this.executeDisconnect(command);
        break;
      case 'vibrate':
        ack = await this.executeVibrate(command);
        break;
    }
    this.emit(ack);
    return ack;
  }

  private async executeScan(command: ScanCommand): Promise<CommandAck> {
    const stale = this.fenceRejection(command);
    if (stale) return this.ack(command.interactionId, 'rejected', stale);
    if (!(await this.authorize(command))) {
      return this.ack(command.interactionId, 'rejected', 'permission-denied');
    }
    const staleAfterPermission = this.fenceRejection(command);
    if (staleAfterPermission) {
      return this.ack(command.interactionId, 'rejected', staleAfterPermission);
    }
    try {
      await this.manager.scan();
      return this.ack(command.interactionId, 'applied', 'scan-started');
    } catch {
      return this.ack(command.interactionId, 'rejected', 'backend-unavailable');
    }
  }

  private async executeDisconnect(command: DisconnectCommand): Promise<CommandAck> {
    const stale = this.fenceRejection(command);
    if (stale) return this.ack(command.interactionId, 'rejected', stale);
    if (!(await this.authorize(command))) {
      return this.ack(command.interactionId, 'rejected', 'permission-denied');
    }
    const staleAfterPermission = this.fenceRejection(command);
    if (staleAfterPermission) {
      return this.ack(command.interactionId, 'rejected', staleAfterPermission);
    }
    const device = this.manager.resolveDevice(command.deviceId);
    if (!device) return this.ack(command.interactionId, 'rejected', 'unknown-device');

    // Disconnect is not a substitute for stop. Fail closed if any output
    // feature could not be stopped before the transport is released.
    for (const target of device.vibrate) {
      const stopped = await this.stopTargetWithBarrier(target);
      if (!stopped) return this.ack(command.interactionId, 'faulted', 'stop-failed');
    }
    try {
      await this.manager.disconnect(command.deviceId);
      return this.ack(command.interactionId, 'applied', 'disconnected');
    } catch {
      return this.ack(command.interactionId, 'rejected', 'disconnect-failed');
    }
  }

  private async executeVibrate(command: VibrateCommand): Promise<CommandAck> {
    const stale = this.fenceRejection(command);
    if (stale) return this.ack(command.interactionId, 'rejected', stale);
    const initialTarget = this.manager.resolveVibrateTarget(command.deviceId, command.featureId);
    if (!initialTarget) return this.ack(command.interactionId, 'rejected', 'unknown-feature');
    if (this.faultLatched) return this.ack(command.interactionId, 'faulted', 'fault-latched');
    if (this.hasStopBarrier(command.featureId)) {
      return this.ack(command.interactionId, 'rejected', 'stop-barrier-active');
    }
    if (initialTarget.faulted) return this.ack(command.interactionId, 'faulted', 'fault-latched');
    if (!(await this.authorize(command))) {
      return this.ack(command.interactionId, 'rejected', 'permission-denied');
    }

    return this.enqueueFeature(command.featureId, async () => {
      const staleAtWrite = this.fenceRejection(command);
      if (staleAtWrite) return this.ack(command.interactionId, 'rejected', staleAtWrite);
      const target = this.manager.resolveVibrateTarget(command.deviceId, command.featureId);
      if (!target) return this.ack(command.interactionId, 'rejected', 'unknown-feature');
      if (this.faultLatched) return this.ack(command.interactionId, 'faulted', 'fault-latched');
      if (this.hasStopBarrier(command.featureId)) {
        return this.ack(command.interactionId, 'rejected', 'stop-barrier-active');
      }
      if (target.faulted) return this.ack(command.interactionId, 'faulted', 'fault-latched');

      const policy = this.readSafetyPolicy();
      if (!policy) return this.ack(command.interactionId, 'rejected', 'invalid-safety-policy');
      if (command.outputLeaseMs > policy.maxOutputLeaseMs) {
        return this.ack(command.interactionId, 'rejected', 'output-lease-too-long');
      }
      const intensity = Math.floor(command.intensity * target.stepCount) / target.stepCount;
      const current = this.outputIntensity.get(command.featureId) ?? 0;
      if (intensity > policy.intensityCap) {
        return this.ack(command.interactionId, 'rejected', 'intensity-cap-exceeded');
      }
      if (current === 0 && intensity > policy.coldStartCap) {
        return this.ack(command.interactionId, 'rejected', 'cold-start-cap-exceeded');
      }
      if (intensity > current && intensity - current > policy.maxIncrease) {
        return this.ack(command.interactionId, 'rejected', 'intensity-step-exceeded');
      }

      try {
        await this.manager.writeVibrate(target, intensity);
      } catch {
        const stopped = await this.stopTargetWithBarrier(target);
        return this.ack(
          command.interactionId,
          stopped ? 'rejected' : 'faulted',
          stopped ? 'write-failed-stopped' : 'stop-failed',
        );
      }

      // A stop, topology change, or lease transition may have happened while
      // the native write was in flight. The late write is followed by stop.
      const staleAfterWrite = this.fenceRejection(command);
      if (staleAfterWrite) {
        const stopped = await this.stopTargetWithBarrier(target);
        return this.ack(
          command.interactionId,
          stopped ? 'rejected' : 'faulted',
          stopped ? 'stale-after-write-stopped' : 'stop-failed',
        );
      }

      this.outputIntensity.set(command.featureId, intensity);
      this.replaceWatchdog(target, command.outputLeaseMs);
      return this.ack(command.interactionId, 'applied', 'write-accepted', intensity);
    });
  }

  private async executeStop(
    command: Extract<RuntimeCommand, { type: 'stop' }>,
  ): Promise<CommandAck> {
    const target = this.manager.resolveVibrateTarget(command.deviceId, command.featureId);
    if (!target) {
      const emergency = await this.executeEmergencyStop(command.interactionId);
      return {
        ...emergency,
        code: emergency.status === 'stopped' ? 'stale-target-emergency-stopped' : emergency.code,
      };
    }
    const stopped = await this.stopTargetWithBarrier(target);
    return this.ack(
      command.interactionId,
      stopped ? 'stopped' : 'faulted',
      stopped ? 'stopped' : 'stop-failed',
    );
  }

  private async executeEmergencyStop(interactionId: string): Promise<CommandAck> {
    const targets = this.manager.allVibrateTargets();
    this.globalBarrierDepth += 1;
    this.manager.advanceSafetyGeneration();
    this.clearAllWatchdogs();
    this.outputIntensity.clear();
    try {
      await this.manager.stopAll();
      return this.ack(interactionId, 'stopped', 'emergency-stopped');
    } catch {
      this.faultLatched = true;
      for (const target of targets) this.manager.latchStopFault(target);
      return this.ack(interactionId, 'faulted', 'stop-failed');
    } finally {
      this.globalBarrierDepth -= 1;
    }
  }

  private async authorize(
    command: ScanCommand | DisconnectCommand | VibrateCommand,
  ): Promise<boolean> {
    try {
      const result = await this.options.permissionPolicy.authorize({
        moduleId: command.moduleId,
        interactionId: command.interactionId,
        action: command.type,
        ...(command.type === 'disconnect' || command.type === 'vibrate'
          ? { deviceId: command.deviceId }
          : {}),
        ...(command.type === 'vibrate'
          ? {
              featureId: command.featureId,
              intensity: command.intensity,
              outputLeaseMs: command.outputLeaseMs,
            }
          : {}),
      });
      return result === 'allow';
    } catch {
      return false;
    }
  }

  private fenceRejection(command: RuntimeFence): string | null {
    const snapshot = this.manager.snapshot();
    if (command.sessionId !== snapshot.sessionId) return 'stale-session';
    if (command.topologyGeneration !== snapshot.topologyGeneration) return 'stale-topology';
    if (command.safetyGeneration !== snapshot.safetyGeneration) return 'stale-safety';
    const lease = this.options.leaseSnapshot();
    if (lease.epoch !== command.leaseEpoch || lease.holder !== command.moduleId) {
      return 'stale-lease';
    }
    return null;
  }

  private readSafetyPolicy(): DeviceSafetyPolicy | null {
    let policy: DeviceSafetyPolicy;
    try {
      policy = this.options.safetyPolicy();
    } catch {
      return null;
    }
    const normalized = [policy.intensityCap, policy.maxIncrease, policy.coldStartCap];
    if (normalized.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) return null;
    if (
      !Number.isSafeInteger(policy.maxOutputLeaseMs) ||
      policy.maxOutputLeaseMs < 1 ||
      policy.maxOutputLeaseMs > MAX_OUTPUT_LEASE_MS
    ) {
      return null;
    }
    return policy;
  }

  private enqueueFeature(
    featureId: string,
    operation: () => Promise<CommandAck>,
  ): Promise<CommandAck> {
    const queue = this.queues.get(featureId) ?? { tail: Promise.resolve() };
    this.queues.set(featureId, queue);
    const task = queue.tail.then(operation);
    queue.tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async stopTargetWithBarrier(target: VibrateTarget): Promise<boolean> {
    this.enterFeatureBarrier(target.featureId);
    this.manager.advanceSafetyGeneration();
    try {
      this.clearWatchdog(target.featureId);
      this.outputIntensity.set(target.featureId, 0);
      await this.manager.stopFeature(target);
      return true;
    } catch {
      this.faultLatched = true;
      this.manager.latchStopFault(target);
      return false;
    } finally {
      this.leaveFeatureBarrier(target.featureId);
    }
  }

  private preemptBackendTransition(): void {
    this.globalBarrierDepth += 1;
    this.clearAllWatchdogs();
    this.outputIntensity.clear();
    const targets = this.manager.allVibrateTargets();
    void this.manager
      .stopAll()
      .catch(() => {
        this.faultLatched = true;
        for (const target of targets) this.manager.latchStopFault(target);
      })
      .finally(() => {
        this.globalBarrierDepth -= 1;
      });
  }

  private hasStopBarrier(featureId: string): boolean {
    return this.globalBarrierDepth > 0 || (this.featureBarriers.get(featureId) ?? 0) > 0;
  }

  private enterFeatureBarrier(featureId: string): void {
    this.featureBarriers.set(featureId, (this.featureBarriers.get(featureId) ?? 0) + 1);
  }

  private leaveFeatureBarrier(featureId: string): void {
    const depth = this.featureBarriers.get(featureId) ?? 0;
    if (depth <= 1) this.featureBarriers.delete(featureId);
    else this.featureBarriers.set(featureId, depth - 1);
  }

  private replaceWatchdog(target: VibrateTarget, delayMs: number): void {
    this.clearWatchdog(target.featureId);
    if ((this.outputIntensity.get(target.featureId) ?? 0) <= 0) return;
    const handle = this.setTimer(() => {
      void this.stopTargetWithBarrier(target);
    }, delayMs);
    this.watchdogs.set(target.featureId, { handle });
  }

  private clearWatchdog(featureId: string): void {
    const watchdog = this.watchdogs.get(featureId);
    if (!watchdog) return;
    this.clearTimer(watchdog.handle);
    this.watchdogs.delete(featureId);
  }

  private clearAllWatchdogs(): void {
    for (const watchdog of this.watchdogs.values()) this.clearTimer(watchdog.handle);
    this.watchdogs.clear();
  }

  private ack(
    interactionId: string,
    status: CommandAck['status'],
    code: string,
    appliedIntensity?: number,
  ): CommandAck {
    const snapshot = this.manager.snapshot();
    return {
      version: DEVICE_RUNTIME_SCHEMA_VERSION,
      type: 'ack',
      interactionId,
      status,
      code,
      hardwareState: 'unknown',
      sessionId: snapshot.sessionId,
      topologyGeneration: snapshot.topologyGeneration,
      safetyGeneration: snapshot.safetyGeneration,
      ...(appliedIntensity === undefined ? {} : { appliedIntensity }),
    };
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Tool/event observers must not change native safety outcomes.
      }
    }
  }
}
