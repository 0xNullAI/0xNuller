import type {
  DeviceClient,
  DeviceCommand,
  DeviceCommandResult,
  DeviceState,
  LlmClient,
  LlmImageInput,
  OpossumCommand,
  ToolCall,
} from '@dg-agent/core';
import { createEmptyDeviceState } from '@dg-agent/core';
import { createEmptyOpossumState, type OpossumState } from '@dg-kit/protocol';
import { hasDeviceLease, type DeviceSummary } from '@dg-kit/safety';
import {
  WebBluetoothDeviceClient,
  WebBluetoothOpossumClient,
} from '@dg-kit/transport-webbluetooth';
import {
  VideoControlRuntime,
  getAnyPromptPresetById,
  type VideoControlGrantInput,
  type VideoControlGrantSnapshot,
  type VideoControlRuntimeOptions,
  type OpossumClient,
  type VideoControlSafetyLimits,
} from '@dg-agent/runtime';
import { BrowserWaveformLibrary } from '@dg-agent/waveforms';
import { connectAnyDgLabDevice } from './connect-any-device.js';
import { MultiCoyoteDeviceClient, type ConnectedCoyote } from './multi-coyote-client.js';

export interface BrowserVideoSceneLibrary {
  selectedId: string;
  scenes: Array<{ id: string; name: string; prompt: string; icon?: string }>;
}

export interface BrowserVideoControlOptions {
  getLlm: () => LlmClient | null;
  getSafetyLimits: () => VideoControlSafetyLimits;
  getSceneLibrary?: () => BrowserVideoSceneLibrary;
  hasLease?: () => boolean;
  onEffectSettled?: VideoControlRuntimeOptions['onEffectSettled'];
  /** Native shells inject Tauri clients; web defaults to a multi-Coyote aggregate. */
  device?: DeviceClient;
  opossum?: OpossumClient;
  connectOutputDevice?: (clients: {
    device: DeviceClient;
    opossum: OpossumClient;
  }) => Promise<{ kind: string; name: string }>;
}

export interface BrowserVideoControlInputs {
  llm: LlmClient | null;
  safetyLimits: VideoControlSafetyLimits;
  sceneLibrary?: BrowserVideoSceneLibrary;
}

export interface BrowserVideoCoyoteTarget {
  targetId: string;
  kind: 'coyote';
  name: string;
  state: DeviceState;
}

export interface BrowserVideoOpossumTarget {
  targetId: string;
  kind: 'opossum';
  name: string;
  state: OpossumState;
}

export type BrowserVideoOutputTarget = BrowserVideoCoyoteTarget | BrowserVideoOpossumTarget;

export interface BrowserVideoDeviceSnapshot {
  /** First/selected state retained for existing shell status consumers. */
  coyote: DeviceState;
  opossum: OpossumState;
  coyotes: BrowserVideoCoyoteTarget[];
  opossumTarget: BrowserVideoOpossumTarget | null;
}

export type VideoOutputKind = 'coyote' | 'opossum';

export interface BrowserVideoAiAction {
  id: string;
  action: 'start' | 'adjust' | 'stop' | 'burst';
  channel: 'A' | 'B';
  value?: number;
  durationMs?: number;
}

interface MultiCoyoteTargetClient extends DeviceClient {
  getConnectedCoyotes(): ConnectedCoyote[];
  getDeviceStateById(deviceId: string): Promise<DeviceState | null>;
  executeDeviceById(deviceId: string, command: DeviceCommand): Promise<DeviceCommandResult | null>;
  selectDeviceById(deviceId: string): void;
  disconnectDeviceById(deviceId: string): Promise<void>;
  emergencyStopDeviceById(deviceId: string): Promise<boolean>;
}

interface CoyoteTargetRecord extends BrowserVideoCoyoteTarget {
  sourceId: string;
}

/** Browser transport composition behind a Video-specific, narrow API. */
export class BrowserVideoControlService {
  private readonly device: DeviceClient;
  private readonly multiCoyote: MultiCoyoteTargetClient | null;
  private readonly opossum: OpossumClient;
  private readonly runtime: VideoControlRuntime;
  private readonly connectOutputDevice: BrowserVideoControlOptions['connectOutputDevice'];
  private readonly listeners = new Set<(snapshot: BrowserVideoDeviceSnapshot) => void>();
  private readonly coyoteTargetsBySource = new Map<string, CoyoteTargetRecord>();
  private opossumTarget: BrowserVideoOpossumTarget | null = null;
  private llm: LlmClient | null;
  private safetyLimits: VideoControlSafetyLimits;
  private sceneLibrary: BrowserVideoSceneLibrary | undefined;
  private nextTargetId = 1;
  private readonly targetNamespace = Math.random().toString(36).slice(2, 10);
  private snapshot: BrowserVideoDeviceSnapshot = emptySnapshot();

  constructor(options: BrowserVideoControlOptions) {
    this.device =
      options.device ??
      new MultiCoyoteDeviceClient((protocol) => new WebBluetoothDeviceClient({ protocol }));
    this.multiCoyote = isMultiCoyoteTargetClient(this.device) ? this.device : null;
    this.opossum = options.opossum ?? new WebBluetoothOpossumClient();
    this.connectOutputDevice = options.connectOutputDevice;
    this.llm = options.getLlm();
    this.safetyLimits = options.getSafetyLimits();
    this.sceneLibrary = options.getSceneLibrary?.();
    this.runtime = new VideoControlRuntime({
      device: this.device,
      opossum: this.opossum,
      getLlm: () => this.llm,
      getSafetyLimits: () => this.safetyLimits,
      getScene: () => {
        const library = this.sceneLibrary;
        if (!library) return null;
        const selected = getAnyPromptPresetById(library.selectedId, library.scenes);
        return selected ? { name: selected.name, prompt: selected.prompt } : null;
      },
      hasLease: options.hasLease ?? (() => hasDeviceLease('video')),
      targetRouter: {
        selectTarget: (kind, targetId) => this.selectTarget(kind, targetId),
        getCoyoteState: (targetId) => this.getCoyoteState(targetId),
        getOpossumState: (targetId) => this.getOpossumState(targetId),
        executeCoyote: (targetId, command) => this.executeCoyote(targetId, command),
        executeOpossum: (targetId, command) => this.executeOpossum(targetId, command),
        stopTarget: (kind, targetId) => this.stopTarget(kind, targetId),
      },
      waveformLibrary: new BrowserWaveformLibrary(),
      onEffectSettled: options.onEffectSettled,
    });
    this.device.onStateChanged((state) => {
      this.reconcileCoyotes(state);
      this.emit();
    });
    this.opossum.onStateChanged((state) => {
      this.reconcileOpossum(state);
      this.emit();
    });
    void this.refresh().catch(() => undefined);
  }

  updateInputs(inputs: BrowserVideoControlInputs): void {
    this.llm = inputs.llm;
    this.safetyLimits = inputs.safetyLimits;
    this.sceneLibrary = inputs.sceneLibrary;
  }

  getSnapshot(): BrowserVideoDeviceSnapshot {
    return {
      coyote: { ...this.snapshot.coyote },
      opossum: { ...this.snapshot.opossum },
      coyotes: this.snapshot.coyotes.map(cloneCoyoteTarget),
      opossumTarget: this.snapshot.opossumTarget
        ? cloneOpossumTarget(this.snapshot.opossumTarget)
        : null,
    };
  }

  getTargets(): BrowserVideoOutputTarget[] {
    const snapshot = this.getSnapshot();
    return [...snapshot.coyotes, ...(snapshot.opossumTarget ? [snapshot.opossumTarget] : [])];
  }

  supportsMultipleCoyotes(): boolean {
    return this.multiCoyote !== null;
  }

  subscribe(listener: (snapshot: BrowserVideoDeviceSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  async connect(kind?: VideoOutputKind): Promise<BrowserVideoOutputTarget> {
    const beforeIds = new Set(this.getTargets().map((target) => target.targetId));
    if (
      kind === undefined &&
      (this.snapshot.opossum.connected || (!this.multiCoyote && this.snapshot.coyote.connected))
    ) {
      throw new Error('当前传输只能通过明确的设备类型继续连接，以保护现有目标身份');
    }
    if (kind === 'coyote') {
      if (!this.multiCoyote && this.snapshot.coyote.connected) {
        throw new Error('当前传输无法证明多个郊狼身份，请先断开现有设备');
      }
      await this.device.connect();
    } else if (kind === 'opossum') {
      if (this.snapshot.opossum.connected) throw new Error('负鼠设备已连接');
      await this.opossum.connect();
    } else {
      const result = this.connectOutputDevice
        ? await this.connectOutputDevice({ device: this.device, opossum: this.opossum })
        : await connectAnyDgLabDevice({ device: this.device, opossum: this.opossum });
      if (result.kind !== 'coyote' && result.kind !== 'opossum') {
        throw new Error('Video 仅支持郊狼与负鼠输出设备');
      }
      kind = result.kind;
      if (kind === 'opossum' && this.opossumTarget) this.opossumTarget = null;
    }

    await this.refresh();
    const target =
      this.getTargets().find(
        (candidate) => candidate.kind === kind && !beforeIds.has(candidate.targetId),
      ) ?? this.getTargets().find((candidate) => candidate.kind === kind);
    if (!target) throw new Error('连接后无法确认物理目标身份');
    return target;
  }

  async disconnect(targetIdOrKind: string): Promise<void> {
    if (targetIdOrKind === 'coyote') {
      await this.device.disconnect();
    } else if (targetIdOrKind === 'opossum') {
      await this.opossum.disconnect();
    } else {
      const coyote = this.findCoyoteTarget(targetIdOrKind);
      if (coyote) {
        if (this.multiCoyote) await this.multiCoyote.disconnectDeviceById(coyote.sourceId);
        else await this.device.disconnect();
      } else if (this.opossumTarget?.targetId === targetIdOrKind) {
        await this.opossum.disconnect();
      } else {
        return;
      }
    }
    await this.refresh();
  }

  getDeviceSummaries(safety: VideoControlSafetyLimits): DeviceSummary[] {
    const out: DeviceSummary[] = this.snapshot.coyotes.map((target) => ({
      id: target.targetId,
      kind: 'coyote',
      name: target.name,
      connected: true,
      battery: target.state.battery,
      active: target.state.strengthA > 0 || target.state.strengthB > 0,
      channels: [
        { label: 'A', value: target.state.strengthA, max: safety.maxStrengthA },
        { label: 'B', value: target.state.strengthB, max: safety.maxStrengthB },
      ],
    }));
    const target = this.snapshot.opossumTarget;
    if (target) {
      out.push({
        id: target.targetId,
        kind: 'opossum',
        name: target.name,
        connected: true,
        battery: target.state.battery,
        active: target.state.intensityA > 0 || target.state.intensityB > 0,
        channels: [
          { label: 'A', value: target.state.intensityA, max: safety.maxIntensityA },
          { label: 'B', value: target.state.intensityB, max: safety.maxIntensityB },
        ],
      });
    }
    return out;
  }

  authorize(input: VideoControlGrantInput): Promise<VideoControlGrantSnapshot> {
    return this.runtime.authorize(input);
  }

  async executeAiAction(
    target: BrowserVideoOutputTarget,
    action: BrowserVideoAiAction,
    grant: Omit<VideoControlGrantInput, 'targetKind' | 'targetId' | 'channel'>,
  ): Promise<string> {
    const current = this.runtime.getGrant();
    if (
      !current ||
      current.revoked ||
      current.targetKind !== target.kind ||
      current.targetId !== target.targetId ||
      current.channel !== action.channel
    ) {
      if (current && !current.revoked) await this.runtime.stop('device-loss');
      await this.runtime.authorize({
        ...grant,
        targetKind: target.kind,
        targetId: target.targetId,
        channel: action.channel,
      });
    }
    const toolCall = toLegacyVideoToolCall(target.kind, action);
    return this.runtime.executeAuthorizedTool(toolCall);
  }

  getGrant(): VideoControlGrantSnapshot | null {
    return this.runtime.getGrant();
  }

  beginRun(): number {
    return this.runtime.beginRun();
  }

  observe(image: LlmImageInput, signal?: AbortSignal): Promise<string> {
    return this.runtime.observe(image, signal);
  }

  stop(reason: Parameters<VideoControlRuntime['stop']>[0]): Promise<void> {
    return this.runtime.stop(reason);
  }

  emergencyStop(): Promise<void> {
    return this.runtime.emergencyStop();
  }

  isEmergencyLatched(): boolean {
    return this.runtime.isEmergencyLatched();
  }

  async dispose(): Promise<void> {
    this.listeners.clear();
    await this.runtime.dispose();
  }

  private selectTarget(kind: VideoOutputKind, targetId: string): boolean {
    if (kind === 'coyote') {
      const target = this.findCoyoteTarget(targetId);
      if (!target || !target.state.connected) return false;
      if (this.multiCoyote) {
        try {
          this.multiCoyote.selectDeviceById(target.sourceId);
        } catch {
          return false;
        }
      }
      return this.findCoyoteTarget(targetId) === target;
    }
    return this.opossumTarget?.targetId === targetId && this.opossumTarget.state.connected;
  }

  private async getCoyoteState(targetId: string): Promise<DeviceState | null> {
    const target = this.findCoyoteTarget(targetId);
    if (!target || !this.selectTarget('coyote', targetId)) return null;
    if (this.multiCoyote) return this.multiCoyote.getDeviceStateById(target.sourceId);
    const state = await this.device.getState();
    return this.findCoyoteTarget(targetId) === target && state.connected ? state : null;
  }

  private async getOpossumState(targetId: string): Promise<OpossumState | null> {
    const target = this.opossumTarget;
    if (!target || !this.selectTarget('opossum', targetId)) return null;
    const state = await this.opossum.getState();
    return this.opossumTarget === target && state.connected ? state : null;
  }

  private async executeCoyote(
    targetId: string,
    command: DeviceCommand,
  ): Promise<DeviceCommandResult | null> {
    const target = this.findCoyoteTarget(targetId);
    if (!target || !this.selectTarget('coyote', targetId)) return null;
    if (this.multiCoyote) return this.multiCoyote.executeDeviceById(target.sourceId, command);
    const result = await this.device.execute(command);
    return this.findCoyoteTarget(targetId) === target ? result : null;
  }

  private async executeOpossum(targetId: string, command: OpossumCommand) {
    const target = this.opossumTarget;
    if (!target || !this.selectTarget('opossum', targetId)) return null;
    const result = await this.opossum.execute(command);
    return this.opossumTarget === target ? result : null;
  }

  private async stopTarget(kind: VideoOutputKind, targetId: string): Promise<boolean> {
    if (!this.selectTarget(kind, targetId)) return false;
    if (kind === 'coyote') {
      const target = this.findCoyoteTarget(targetId);
      if (!target) return false;
      if (this.multiCoyote) {
        return this.multiCoyote.emergencyStopDeviceById(target.sourceId);
      }
      await this.device.emergencyStop();
      return this.findCoyoteTarget(targetId) === target;
    }
    const target = this.opossumTarget;
    if (!target || target.targetId !== targetId) return false;
    await this.opossum.emergencyStop();
    return this.opossumTarget === target;
  }

  private async refresh(): Promise<void> {
    const [coyote, opossum] = await Promise.all([this.device.getState(), this.opossum.getState()]);
    this.reconcileCoyotes(coyote);
    this.reconcileOpossum(opossum);
    this.emit();
  }

  private reconcileCoyotes(fallbackState: DeviceState): void {
    if (this.multiCoyote) {
      const connected = this.multiCoyote.getConnectedCoyotes();
      const liveSourceIds = new Set(connected.map(({ id }) => id));
      for (const sourceId of this.coyoteTargetsBySource.keys()) {
        if (!liveSourceIds.has(sourceId)) this.coyoteTargetsBySource.delete(sourceId);
      }
      for (const item of connected) {
        const current = this.coyoteTargetsBySource.get(item.id);
        if (current) {
          current.state = { ...item.state };
          current.name = item.state.deviceName ?? current.name;
        } else {
          this.coyoteTargetsBySource.set(item.id, {
            sourceId: item.id,
            targetId: this.createTargetId('coyote'),
            kind: 'coyote',
            name: item.state.deviceName ?? '郊狼',
            state: { ...item.state },
          });
        }
      }
    } else if (fallbackState.connected) {
      const current = this.coyoteTargetsBySource.get('single');
      if (current) {
        current.state = { ...fallbackState };
        current.name = fallbackState.deviceName ?? current.name;
      } else {
        this.coyoteTargetsBySource.set('single', {
          sourceId: 'single',
          targetId: this.createTargetId('coyote'),
          kind: 'coyote',
          name: fallbackState.deviceName ?? '郊狼',
          state: { ...fallbackState },
        });
      }
    } else {
      this.coyoteTargetsBySource.clear();
    }

    const coyotes = [...this.coyoteTargetsBySource.values()].map(cloneCoyoteTarget);
    this.snapshot = {
      ...this.snapshot,
      coyote: coyotes[0]?.state ?? { ...fallbackState },
      coyotes,
    };
  }

  private reconcileOpossum(state: OpossumState): void {
    if (state.connected) {
      if (this.opossumTarget) {
        this.opossumTarget = {
          ...this.opossumTarget,
          name: state.deviceName ?? this.opossumTarget.name,
          state: { ...state },
        };
      } else {
        this.opossumTarget = {
          targetId: this.createTargetId('opossum'),
          kind: 'opossum',
          name: state.deviceName ?? '负鼠',
          state: { ...state },
        };
      }
    } else {
      this.opossumTarget = null;
    }
    this.snapshot = {
      ...this.snapshot,
      opossum: { ...state },
      opossumTarget: this.opossumTarget ? cloneOpossumTarget(this.opossumTarget) : null,
    };
  }

  private findCoyoteTarget(targetId: string): CoyoteTargetRecord | undefined {
    return [...this.coyoteTargetsBySource.values()].find(
      (candidate) => candidate.targetId === targetId,
    );
  }

  private createTargetId(kind: VideoOutputKind): string {
    return `video-${kind}-${this.targetNamespace}-${this.nextTargetId++}`;
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

export function createBrowserVideoControl(
  options: BrowserVideoControlOptions,
): BrowserVideoControlService {
  return new BrowserVideoControlService(options);
}

function isMultiCoyoteTargetClient(device: DeviceClient): device is MultiCoyoteTargetClient {
  const candidate = device as Partial<MultiCoyoteTargetClient>;
  return (
    typeof candidate.getConnectedCoyotes === 'function' &&
    typeof candidate.getDeviceStateById === 'function' &&
    typeof candidate.executeDeviceById === 'function' &&
    typeof candidate.selectDeviceById === 'function' &&
    typeof candidate.disconnectDeviceById === 'function' &&
    typeof candidate.emergencyStopDeviceById === 'function'
  );
}

function toLegacyVideoToolCall(kind: VideoOutputKind, action: BrowserVideoAiAction): ToolCall {
  const value = action.value ?? 0;
  if (kind === 'coyote') {
    const names = {
      start: 'shock_start',
      adjust: 'shock_adjust',
      stop: 'shock_stop',
      burst: 'shock_burst',
    } as const;
    return {
      id: action.id,
      name: names[action.action],
      args:
        action.action === 'start'
          ? { channel: action.channel, strength: value }
          : action.action === 'adjust'
            ? { channel: action.channel, delta: value }
            : action.action === 'burst'
              ? { channel: action.channel, strength: value, durationMs: action.durationMs ?? 0 }
              : { channel: action.channel },
    };
  }
  const names = {
    start: 'vibrate_start',
    adjust: 'vibrate_adjust',
    stop: 'vibrate_stop',
    burst: 'vibrate_burst',
  } as const;
  return {
    id: action.id,
    name: names[action.action],
    args:
      action.action === 'start'
        ? { channel: action.channel, intensity: value }
        : action.action === 'adjust'
          ? { channel: action.channel, delta: value }
          : action.action === 'burst'
            ? { channel: action.channel, intensity: value, durationMs: action.durationMs ?? 0 }
            : { channel: action.channel },
  };
}

function emptySnapshot(): BrowserVideoDeviceSnapshot {
  return {
    coyote: createEmptyDeviceState(),
    opossum: createEmptyOpossumState(),
    coyotes: [],
    opossumTarget: null,
  };
}

function cloneCoyoteTarget(target: BrowserVideoCoyoteTarget): BrowserVideoCoyoteTarget {
  return {
    targetId: target.targetId,
    kind: 'coyote',
    name: target.name,
    state: { ...target.state },
  };
}

function cloneOpossumTarget(target: BrowserVideoOpossumTarget): BrowserVideoOpossumTarget {
  return { ...target, state: { ...target.state } };
}
