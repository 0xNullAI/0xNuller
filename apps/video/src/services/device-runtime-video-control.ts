import {
  MAX_OUTPUT_LEASE_MS,
  type BoundDeviceTools,
  type CommandAck,
  type DeviceId,
  type DeviceSnapshot,
  type FeatureId,
  type RuntimeEvent,
  type SharedDeviceRuntime,
  type DeviceRuntimeProvider,
} from '@0xnullai/device-runtime';
import {
  createEmptyDeviceState,
  type ActionContext,
  type LlmClient,
  type LlmImageInput,
  type SessionSnapshot,
  type ToolCall,
  type ToolDefinition,
} from '@dg-agent/core';
import {
  VISUAL_SESSION_MAX_CAPTURE_INTERVAL_MS,
  VISUAL_SESSION_MAX_INTERVAL_MS,
  VISUAL_SESSION_MAX_MS,
  VISUAL_SESSION_MIN_CAPTURE_INTERVAL_MS,
  VISUAL_SESSION_MIN_INTERVAL_MS,
  type VisualSafetyStopReason,
} from './visual-session.js';

const VIDEO_RUNTIME_MODULE_ID = 'video';
const VIDEO_RUNTIME_SESSION_ID = 'video-device-runtime-ephemeral';
const MODEL_TOOL_NAMES = new Set([
  'device_snapshot',
  'device_vibrate',
  'device_stop',
  'device_emergency_stop',
]);

export interface DeviceRuntimeVideoGrantInput {
  deviceId: DeviceId;
  featureId: FeatureId;
  intensityCap: number;
  allowEnhanced: boolean;
  durationMs: number;
  cadenceMs: number;
  captureIntervalMs: number;
}

export interface DeviceRuntimeVideoGrantSnapshot extends DeviceRuntimeVideoGrantInput {
  id: string;
  issuedAt: number;
  expiresAt: number;
  revoked: boolean;
}

export interface DeviceRuntimeVideoScene {
  name: string;
  prompt: string;
}

export interface DeviceRuntimeVideoControlInputs {
  llm: LlmClient | null;
  scene: DeviceRuntimeVideoScene | null;
}

export interface DeviceRuntimeVideoControlOptions extends DeviceRuntimeVideoControlInputs {
  provider: DeviceRuntimeProvider;
  hasLease: () => boolean;
  getSafetyIntensityCap?: () => number;
  getMaxOutputLeaseMs?: () => number;
  now?: () => number;
  interactionIdFactory?: (action: string) => string;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onEffectSettled?: (toolCall: ToolCall, output: string | null) => void;
}

/**
 * Video-only adapter over the shared generic DeviceRuntime. It deliberately
 * keeps the legacy Coyote/Opossum control service separate and gives the model
 * only one exact vibration feature plus stop paths.
 */
export class DeviceRuntimeVideoControlService {
  private readonly provider: DeviceRuntimeProvider;
  private readonly hasLease: () => boolean;
  private readonly getSafetyIntensityCap: () => number;
  private readonly getMaxOutputLeaseMs: () => number;
  private readonly now: () => number;
  private readonly interactionIdFactory: (action: string) => string;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly onEffectSettled?: DeviceRuntimeVideoControlOptions['onEffectSettled'];
  private readonly listeners = new Set<(snapshot: DeviceSnapshot) => void>();
  private readonly effectControllers = new Set<AbortController>();
  private readonly session: SessionSnapshot;
  private runtime: SharedDeviceRuntime | null = null;
  private tools: BoundDeviceTools | null = null;
  private snapshot: DeviceSnapshot | null = null;
  private unsubscribeSnapshot: (() => void) | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  private llm: LlmClient | null;
  private scene: DeviceRuntimeVideoScene | null;
  private grant: DeviceRuntimeVideoGrant | null = null;
  private grantSessionId: string | null = null;
  private generation = 0;
  private activeInference: AbortController | null = null;
  private appliedIntensity = 0;
  private nonEnhancedCeiling: number | null = null;
  private emergencyLatched = false;
  private deadlineTimer: unknown | null = null;
  private interactionSequence = 0;

  constructor(options: DeviceRuntimeVideoControlOptions) {
    this.provider = options.provider;
    this.hasLease = options.hasLease;
    this.getSafetyIntensityCap = options.getSafetyIntensityCap ?? (() => 1);
    this.getMaxOutputLeaseMs = options.getMaxOutputLeaseMs ?? (() => MAX_OUTPUT_LEASE_MS);
    this.now = options.now ?? Date.now;
    this.interactionIdFactory =
      options.interactionIdFactory ??
      ((action) => `video-${action}-${this.now().toString(36)}-${++this.interactionSequence}`);
    this.setTimer =
      options.setTimer ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((handle) => globalThis.clearTimeout(handle as number));
    this.onEffectSettled = options.onEffectSettled;
    this.llm = options.llm;
    this.scene = options.scene;
    const createdAt = this.now();
    this.session = {
      id: VIDEO_RUNTIME_SESSION_ID,
      createdAt,
      updatedAt: createdAt,
      messages: [],
      deviceState: createEmptyDeviceState(),
    };
    const current = this.provider.current();
    if (current) this.bindRuntime(current);
  }

  updateInputs(inputs: DeviceRuntimeVideoControlInputs): void {
    this.llm = inputs.llm;
    this.scene = inputs.scene;
  }

  getSnapshot(): DeviceSnapshot | null {
    return this.snapshot ? cloneSnapshot(this.snapshot) : null;
  }

  subscribe(listener: (snapshot: DeviceSnapshot) => void): () => void {
    this.listeners.add(listener);
    if (this.snapshot) listener(cloneSnapshot(this.snapshot));
    return () => this.listeners.delete(listener);
  }

  async discoverDevices(): Promise<DeviceSnapshot> {
    const tools = await this.ensureRuntime();
    const ack = await tools.actions.scan({ interactionId: this.interactionId('scan') });
    if (ack.status !== 'applied') throw new Error(`嵌入设备扫描失败：${ack.code}`);
    return cloneSnapshot(tools.actions.snapshot());
  }

  async authorize(input: unknown): Promise<DeviceRuntimeVideoGrantSnapshot> {
    const value = parseGrantInput(input);
    await this.ensureRuntime();
    const target = this.requireLiveVibrateFeature(value.deviceId, value.featureId);
    if (target.feature.faulted) throw new Error('授权振动功能已锁定，请重新连接设备');

    this.invalidateContinuations();
    this.grant?.revoke();
    this.clearDeadline();
    this.appliedIntensity = 0;
    this.nonEnhancedCeiling = null;
    this.grant = new DeviceRuntimeVideoGrant(value, {
      now: this.now,
      safetyIntensityCap: this.readSafetyIntensityCap(),
    });
    this.grantSessionId = this.runtime!.snapshot().sessionId;
    this.emergencyLatched = false;
    this.armDeadline();
    return this.grant.getSnapshot();
  }

  getGrant(): DeviceRuntimeVideoGrantSnapshot | null {
    return this.grant?.getSnapshot() ?? null;
  }

  isEmergencyLatched(): boolean {
    return this.emergencyLatched;
  }

  async beginRun(): Promise<number> {
    if (this.emergencyLatched) throw new Error('紧急停止已锁定，请重新授权后再开始');
    if (!this.grant?.isActive()) throw new Error('控制授权不存在或已过期');
    if (!this.hasLease()) throw new Error('Video 当前没有设备控制权');
    try {
      this.requireCurrentGrantedFeature();
    } catch (error) {
      await this.escalateStaleIdentity(error);
    }
    this.invalidateContinuations();
    return this.generation;
  }

  async observe(image: LlmImageInput, externalSignal?: AbortSignal): Promise<string> {
    if (this.activeInference) throw new Error('已有画面正在分析');
    if (this.emergencyLatched || !this.grant?.isActive() || !this.hasLease()) {
      throw new Error('控制授权不存在、已过期或已失去设备控制权');
    }
    try {
      this.requireCurrentGrantedFeature();
    } catch (error) {
      await this.escalateStaleIdentity(error);
    }
    const llm = this.llm;
    if (!llm?.capabilities?.imageInput) throw new Error('当前模型未声明图片输入能力');

    const generation = this.generation;
    const grant = this.grant.getSnapshot();
    const controller = new AbortController();
    this.activeInference = controller;
    const abort = () => controller.abort();
    externalSignal?.addEventListener('abort', abort, { once: true });

    try {
      const tools = this.modelToolDefinitions(grant);
      const prompt = buildObservationPrompt(grant, this.appliedIntensity);
      const context: ActionContext = {
        sessionId: VIDEO_RUNTIME_SESSION_ID,
        sourceType: 'web',
        traceId: `video-device-runtime-${generation}-${this.now()}`,
      };
      const result = await llm.runTurn({
        session: this.session,
        message: prompt,
        context,
        instructions: buildDeviceRuntimeVideoInstructions(this.scene, grant),
        tools,
        image,
        abortSignal: controller.signal,
        conversation: [{ kind: 'message', role: 'user', content: prompt }],
      });

      if (controller.signal.aborted || generation !== this.generation) {
        throw new DOMException('Video observation aborted', 'AbortError');
      }
      const allowedNames = new Set(tools.map(({ name }) => name));
      const effects = (result.toolCalls ?? []).filter((call) => allowedNames.has(call.name));
      this.executeEffects(effects, generation);
      return result.assistantMessage.trim() || '画面状态已更新';
    } finally {
      externalSignal?.removeEventListener('abort', abort);
      if (this.activeInference === controller) this.activeInference = null;
    }
  }

  async stop(reason: VisualSafetyStopReason): Promise<void> {
    const grant = this.grant?.getSnapshot();
    this.invalidateContinuations();
    if (reason !== 'pause' && reason !== 'stop') {
      this.grant?.revoke();
      this.clearDeadline();
    }
    if (!grant) return;

    if (!this.isExactLiveVibrateFeature(grant.deviceId, grant.featureId)) {
      await this.escalateStaleIdentity(new Error('授权物理目标已断开或身份已失效'));
      return;
    }

    try {
      const ack = await this.requireTools().actions.stop({
        interactionId: this.interactionId('stop'),
        deviceId: grant.deviceId,
        featureId: grant.featureId,
      });
      this.requireStoppedAck(ack);
      this.appliedIntensity = 0;
    } catch (error) {
      await this.latchStopFailure(error);
    }
  }

  async emergencyStop(): Promise<void> {
    this.emergencyLatched = true;
    this.grant?.revoke();
    this.clearDeadline();
    this.invalidateContinuations();
    const current = this.provider.current();
    const runtimes = [...new Set([this.runtime, current].filter(Boolean))] as SharedDeviceRuntime[];
    if (runtimes.length === 0) return;
    const results = await Promise.allSettled(
      runtimes.map(async (runtime) => {
        const ack = await runtime.forModule(VIDEO_RUNTIME_MODULE_ID).actions.emergencyStop({
          interactionId: this.interactionId('emergency'),
        });
        this.requireStoppedAck(ack);
      }),
    );
    if (current && current !== this.runtime) this.bindRuntime(current);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure) throw failure.reason;
    this.appliedIntensity = 0;
  }

  async dispose(): Promise<void> {
    try {
      await this.stop('unmount');
    } finally {
      this.clearDeadline();
      this.unsubscribeSnapshot?.();
      this.unsubscribeEvents?.();
      this.unsubscribeSnapshot = null;
      this.unsubscribeEvents = null;
      this.listeners.clear();
    }
  }

  private async ensureRuntime(): Promise<BoundDeviceTools> {
    const runtime = await this.provider.start();
    if (runtime !== this.runtime) this.bindRuntime(runtime);
    return this.requireTools();
  }

  private bindRuntime(runtime: SharedDeviceRuntime): void {
    this.unsubscribeSnapshot?.();
    this.unsubscribeEvents?.();
    this.runtime = runtime;
    this.tools = runtime.forModule(VIDEO_RUNTIME_MODULE_ID);
    this.snapshot = runtime.snapshot();
    this.unsubscribeSnapshot = runtime.manager.subscribe((snapshot) => {
      this.snapshot = snapshot;
      this.emit();
    });
    this.unsubscribeEvents = runtime.executor.subscribe((event) => this.onRuntimeEvent(event));
    this.emit();
  }

  private onRuntimeEvent(event: RuntimeEvent): void {
    if (event.type !== 'fault') return;
    const grant = this.grant?.getSnapshot();
    if (!grant || event.deviceId !== grant.deviceId || event.featureId !== grant.featureId) return;
    this.emergencyLatched = true;
    this.grant?.revoke();
    this.clearDeadline();
    this.invalidateContinuations();
  }

  private modelToolDefinitions(grant: DeviceRuntimeVideoGrantSnapshot): ToolDefinition[] {
    const outputLeaseCap = this.readMaxOutputLeaseMs();
    return this.requireTools().catalog.flatMap((definition) => {
      if (!MODEL_TOOL_NAMES.has(definition.name)) return [];
      const source = definition.inputSchema as {
        properties?: Record<string, Record<string, unknown>>;
      };
      const sourceProperties = source.properties ?? {};
      const properties: Record<string, Record<string, unknown>> = {};
      const required: string[] = [];
      if (definition.name === 'device_vibrate') {
        properties.deviceId = { ...sourceProperties.deviceId, enum: [grant.deviceId] };
        properties.featureId = { ...sourceProperties.featureId, enum: [grant.featureId] };
        properties.intensity = {
          ...sourceProperties.intensity,
          maximum: Math.min(grant.intensityCap, this.readSafetyIntensityCap()),
        };
        properties.outputLeaseMs = {
          ...sourceProperties.outputLeaseMs,
          maximum: outputLeaseCap,
        };
        required.push('deviceId', 'featureId', 'intensity', 'outputLeaseMs');
      } else if (definition.name === 'device_stop') {
        properties.deviceId = { ...sourceProperties.deviceId, enum: [grant.deviceId] };
        properties.featureId = { ...sourceProperties.featureId, enum: [grant.featureId] };
        required.push('deviceId', 'featureId');
      }
      return [
        {
          name: definition.name,
          description: definition.description,
          parameters: {
            type: 'object',
            properties,
            required,
            additionalProperties: false,
          },
        },
      ];
    });
  }

  private executeEffects(toolCalls: ToolCall[], generation: number): void {
    if (toolCalls.length === 0) return;
    const controller = new AbortController();
    this.effectControllers.add(controller);
    void (async () => {
      for (const toolCall of toolCalls) {
        if (controller.signal.aborted || generation !== this.generation) break;
        try {
          const output = await this.executeEffect(toolCall, generation);
          this.onEffectSettled?.(toolCall, JSON.stringify(output));
        } catch {
          this.onEffectSettled?.(toolCall, null);
          if (!this.emergencyLatched && this.grant?.isActive()) {
            await this.stop('model-failures').catch(() => undefined);
          }
          break;
        }
      }
    })().finally(() => this.effectControllers.delete(controller));
  }

  private async executeEffect(toolCall: ToolCall, generation: number): Promise<unknown> {
    switch (toolCall.name) {
      case 'device_snapshot':
        requireExactArgs(toolCall.args, []);
        return this.snapshotForGrantedTarget();
      case 'device_vibrate':
        return this.executeVibrate(toolCall.args, generation);
      case 'device_stop':
        return this.executeModelStop(toolCall.args);
      case 'device_emergency_stop':
        requireExactArgs(toolCall.args, []);
        await this.emergencyStop();
        return { status: 'stopped' };
      default:
        throw new Error('Video 模型请求了未授权的设备能力');
    }
  }

  private async executeVibrate(
    args: Record<string, unknown>,
    generation: number,
  ): Promise<CommandAck> {
    requireExactArgs(args, ['deviceId', 'featureId', 'intensity', 'outputLeaseMs']);
    const grant = this.requireActiveGrant();
    const deviceId = requireExactId(args.deviceId, grant.deviceId, 'deviceId') as DeviceId;
    const featureId = requireExactId(args.featureId, grant.featureId, 'featureId') as FeatureId;
    const intensity = requireFiniteNumber(args.intensity, 'intensity');
    const outputLeaseMs = requireSafeInteger(args.outputLeaseMs, 'outputLeaseMs');

    if (
      generation !== this.generation ||
      this.emergencyLatched ||
      !this.hasLease() ||
      !grantIsCurrent(this.grant, grant)
    ) {
      throw new Error('Video 控制工作已失效');
    }
    try {
      this.requireCurrentGrantedFeature();
    } catch (error) {
      await this.escalateStaleIdentity(error);
    }
    const cap = Math.min(grant.intensityCap, this.readSafetyIntensityCap());
    if (intensity < 0 || intensity > cap) throw new Error('模型请求强度超过 Video 授权上限');
    if (outputLeaseMs < 1 || outputLeaseMs > this.readMaxOutputLeaseMs()) {
      throw new Error('模型请求的输出租期超过 Video 上限');
    }
    if (
      !grant.allowEnhanced &&
      this.nonEnhancedCeiling !== null &&
      intensity > this.nonEnhancedCeiling
    ) {
      throw new Error('Video 授权不允许通过停止后重启来增强输出');
    }

    // This is the final Video adapter gate before the shared executor. The
    // executor independently rechecks topology, lease, policy, and stop fences.
    const ack = await this.requireTools().actions.vibrate({
      interactionId: this.interactionId('vibrate'),
      deviceId,
      featureId,
      intensity,
      outputLeaseMs,
    });
    if (ack.status !== 'applied') {
      await this.failClosedAfterEffect(ack);
      throw new Error(`设备拒绝 Video 输出：${ack.code}`);
    }
    this.appliedIntensity = ack.appliedIntensity ?? intensity;
    if (!grant.allowEnhanced && this.appliedIntensity > 0 && this.nonEnhancedCeiling === null) {
      this.nonEnhancedCeiling = this.appliedIntensity;
    }
    return ack;
  }

  private async executeModelStop(args: Record<string, unknown>): Promise<{ status: 'stopped' }> {
    requireExactArgs(args, ['deviceId', 'featureId']);
    const grant = this.requireGrantSnapshot();
    requireExactId(args.deviceId, grant.deviceId, 'deviceId');
    requireExactId(args.featureId, grant.featureId, 'featureId');
    await this.stop('stop');
    return { status: 'stopped' };
  }

  private async failClosedAfterEffect(ack: CommandAck): Promise<void> {
    if (ack.status === 'faulted' || ack.code === 'stop-failed') {
      await this.latchStopFailure(new Error(ack.code));
      return;
    }
    await this.stop('device-loss');
  }

  private snapshotForGrantedTarget(): DeviceSnapshot {
    const grant = this.requireGrantSnapshot();
    const snapshot = this.requireRuntime().snapshot();
    return {
      ...cloneSnapshot(snapshot),
      devices: snapshot.devices
        .filter(({ deviceId }) => deviceId === grant.deviceId)
        .map((device) => ({
          ...device,
          capabilities: device.capabilities.filter(
            ({ featureId }) => featureId === grant.featureId,
          ),
        })),
    };
  }

  private requireCurrentGrantedFeature(): void {
    const grant = this.requireActiveGrant();
    const runtime = this.requireRuntime();
    if (
      this.provider.current() !== runtime ||
      runtime.snapshot().sessionId !== this.grantSessionId
    ) {
      throw new Error('授权设备运行时身份已失效');
    }
    const target = this.requireLiveVibrateFeature(grant.deviceId, grant.featureId);
    if (target.feature.faulted) throw new Error('授权振动功能已锁定');
  }

  private requireLiveVibrateFeature(deviceId: DeviceId, featureId: FeatureId) {
    const snapshot = this.requireRuntime().snapshot();
    const device = snapshot.devices.find((candidate) => candidate.deviceId === deviceId);
    const feature = device?.capabilities.find((candidate) => candidate.featureId === featureId);
    if (!device || !feature || feature.kind !== 'vibrate') {
      throw new Error('授权物理目标已断开、不是振动功能或身份已失效');
    }
    return { device, feature };
  }

  private isExactLiveVibrateFeature(deviceId: DeviceId, featureId: FeatureId): boolean {
    try {
      this.requireLiveVibrateFeature(deviceId, featureId);
      return this.provider.current() === this.runtime;
    } catch {
      return false;
    }
  }

  private async escalateStaleIdentity(error: unknown): Promise<never> {
    this.emergencyLatched = true;
    this.grant?.revoke();
    this.clearDeadline();
    this.invalidateContinuations();
    await this.emergencyStop();
    throw error instanceof Error ? error : new Error('授权物理目标身份已失效');
  }

  private async latchStopFailure(error: unknown): Promise<never> {
    this.emergencyLatched = true;
    this.grant?.revoke();
    this.clearDeadline();
    this.invalidateContinuations();
    await this.emergencyStop();
    throw error instanceof Error ? error : new Error('无法确认设备已停止');
  }

  private requireStoppedAck(ack: CommandAck): void {
    if (ack.status !== 'stopped') throw new Error(`无法确认设备已停止：${ack.code}`);
  }

  private requireGrantSnapshot(): DeviceRuntimeVideoGrantSnapshot {
    const grant = this.grant?.getSnapshot();
    if (!grant) throw new Error('Video 控制授权不存在');
    return grant;
  }

  private requireActiveGrant(): DeviceRuntimeVideoGrantSnapshot {
    if (!this.grant?.isActive()) throw new Error('Video 控制授权不存在或已过期');
    return this.grant.getSnapshot();
  }

  private requireRuntime(): SharedDeviceRuntime {
    if (!this.runtime) throw new Error('嵌入设备运行时尚未启动');
    return this.runtime;
  }

  private requireTools(): BoundDeviceTools {
    if (!this.tools) throw new Error('嵌入设备运行时尚未启动');
    return this.tools;
  }

  private readSafetyIntensityCap(): number {
    let cap: number;
    try {
      cap = this.getSafetyIntensityCap();
    } catch {
      return 0;
    }
    return Number.isFinite(cap) ? Math.min(1, Math.max(0, cap)) : 0;
  }

  private readMaxOutputLeaseMs(): number {
    let cap: number;
    try {
      cap = this.getMaxOutputLeaseMs();
    } catch {
      return 1;
    }
    if (!Number.isSafeInteger(cap)) return 1;
    return Math.min(MAX_OUTPUT_LEASE_MS, Math.max(1, cap));
  }

  private interactionId(action: string): string {
    const value = this.interactionIdFactory(action);
    if (!value || value.length > 128) throw new Error('Video interaction id 无效');
    return value;
  }

  private invalidateContinuations(): void {
    this.generation += 1;
    this.activeInference?.abort();
    this.activeInference = null;
    for (const controller of this.effectControllers) controller.abort();
    this.effectControllers.clear();
  }

  private armDeadline(): void {
    this.clearDeadline();
    const grant = this.grant?.getSnapshot();
    if (!grant) return;
    this.deadlineTimer = this.setTimer(
      () => {
        this.deadlineTimer = null;
        void this.stop('grant-expired').catch(() => undefined);
      },
      Math.max(0, grant.expiresAt - this.now()),
    );
  }

  private clearDeadline(): void {
    if (this.deadlineTimer !== null) this.clearTimer(this.deadlineTimer);
    this.deadlineTimer = null;
  }

  private emit(): void {
    if (!this.snapshot) return;
    for (const listener of this.listeners) listener(cloneSnapshot(this.snapshot));
  }
}

class DeviceRuntimeVideoGrant {
  private revoked = false;
  private readonly now: () => number;
  private readonly snapshot: Omit<DeviceRuntimeVideoGrantSnapshot, 'revoked'>;

  constructor(
    input: DeviceRuntimeVideoGrantInput,
    options: { now: () => number; safetyIntensityCap: number },
  ) {
    this.now = options.now;
    const issuedAt = this.now();
    const durationMs = clampInteger(input.durationMs, 1_000, VISUAL_SESSION_MAX_MS);
    this.snapshot = {
      id: `video-runtime-grant-${issuedAt}-${Math.random().toString(36).slice(2, 8)}`,
      deviceId: input.deviceId,
      featureId: input.featureId,
      intensityCap: Math.min(input.intensityCap, options.safetyIntensityCap),
      allowEnhanced: input.allowEnhanced,
      durationMs,
      cadenceMs: clampInteger(
        input.cadenceMs,
        VISUAL_SESSION_MIN_INTERVAL_MS,
        VISUAL_SESSION_MAX_INTERVAL_MS,
      ),
      captureIntervalMs: clampInteger(
        input.captureIntervalMs,
        VISUAL_SESSION_MIN_CAPTURE_INTERVAL_MS,
        VISUAL_SESSION_MAX_CAPTURE_INTERVAL_MS,
      ),
      issuedAt,
      expiresAt: issuedAt + durationMs,
    };
  }

  getSnapshot(): DeviceRuntimeVideoGrantSnapshot {
    return { ...this.snapshot, revoked: this.revoked };
  }

  isActive(): boolean {
    return !this.revoked && this.now() < this.snapshot.expiresAt;
  }

  revoke(): void {
    this.revoked = true;
  }
}

function parseGrantInput(input: unknown): DeviceRuntimeVideoGrantInput {
  const value = requirePlainObject(input, 'Video grant');
  const keys = [
    'deviceId',
    'featureId',
    'intensityCap',
    'allowEnhanced',
    'durationMs',
    'cadenceMs',
    'captureIntervalMs',
  ] as const;
  requireExactArgs(value, keys);
  const deviceId = requireNonEmptyString(value.deviceId, 'deviceId') as DeviceId;
  const featureId = requireNonEmptyString(value.featureId, 'featureId') as FeatureId;
  const intensityCap = requireFiniteNumber(value.intensityCap, 'intensityCap');
  if (intensityCap < 0 || intensityCap > 1) throw new Error('intensityCap 必须在 0..1');
  if (typeof value.allowEnhanced !== 'boolean') throw new Error('allowEnhanced 必须是布尔值');
  return {
    deviceId,
    featureId,
    intensityCap,
    allowEnhanced: value.allowEnhanced,
    durationMs: requireSafeInteger(value.durationMs, 'durationMs'),
    cadenceMs: requireSafeInteger(value.cadenceMs, 'cadenceMs'),
    captureIntervalMs: requireSafeInteger(value.captureIntervalMs, 'captureIntervalMs'),
  };
}

function buildObservationPrompt(
  grant: DeviceRuntimeVideoGrantSnapshot,
  currentIntensity: number,
): string {
  return `观察最新画面并继续当前场景。当前授权目标是一个通用振动功能，当前已确认强度 ${currentIntensity.toFixed(3)}，授权上限 ${grant.intensityCap.toFixed(3)}。只依据画面中可见事实决定保持、降低、停止或推进。`;
}

export function buildDeviceRuntimeVideoInstructions(
  scene: DeviceRuntimeVideoScene | null,
  grant: DeviceRuntimeVideoGrantSnapshot,
): string {
  const sceneText = scene
    ? `当前选定场景「${scene.name}」：\n${scene.prompt}`
    : '当前选定场景：温和、尊重边界地陪伴。';
  return `${sceneText}\n\n你是主动观察最新画面的场景主持者。每次只处理当前这一帧，不假设过去画面仍然成立。\n- 只依据画面里直接可见的姿态、动作、物体与变化；不得猜测身份、敏感属性或不可见意图。\n- 主动推进选定场景，语言自然简洁；可以使用已提供的控制能力，但绝不向用户暴露工具名、参数、协议、设备实现、设备标识或内部判断过程。\n- 画面含糊、遮挡、无人或反馈不确定时，只保持、降低或停止，绝不提高。\n- 任何停止、拒绝、不适、危险或设备异常迹象拥有最高优先级：立即全局停止，不做替代推进。\n- 仅控制工具枚举中唯一的设备与振动功能，归一化强度不得超过 ${grant.intensityCap.toFixed(3)}。${grant.allowEnhanced ? '允许在授权和安全策略内小步增强。' : '首次启动后禁止增强，只能保持、降低或停止。'}\n- 输出租期必须保持短暂；需要继续时重新观察并重新发出有界指令。`;
}

function requirePlainObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} 必须是普通对象`);
  }
  return value as Record<string, unknown>;
}

function requireExactArgs(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const input = requirePlainObject(value, '工具参数');
  const allowed = new Set(keys);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error('工具参数包含未知字段');
  if (keys.some((key) => !Object.hasOwn(input, key))) throw new Error('工具参数缺少必填字段');
  return input;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 160) {
    throw new Error(`${label} 必须是有效标识`);
  }
  return value;
}

function requireExactId(value: unknown, expected: string, label: string): string {
  const actual = requireNonEmptyString(value, label);
  if (actual !== expected) throw new Error(`${label} 不属于当前 Video 授权`);
  return actual;
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`${label} 必须是有限数值`);
  return value;
}

function requireSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} 必须是安全整数`);
  return value as number;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function grantIsCurrent(
  grant: DeviceRuntimeVideoGrant | null,
  snapshot: DeviceRuntimeVideoGrantSnapshot,
): boolean {
  return grant?.getSnapshot().id === snapshot.id && grant.isActive();
}

function cloneSnapshot(snapshot: DeviceSnapshot): DeviceSnapshot {
  return {
    ...snapshot,
    devices: snapshot.devices.map((device) => ({
      ...device,
      capabilities: device.capabilities.map((capability) => ({ ...capability })),
    })),
  };
}
