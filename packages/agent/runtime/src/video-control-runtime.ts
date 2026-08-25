import {
  createEmptyDeviceState,
  type ActionContext,
  type DeviceClient,
  type DeviceCommand,
  type DeviceCommandResult,
  type DeviceState,
  type LlmClient,
  type LlmImageInput,
  type OpossumCommand,
  type PermissionService,
  type RuntimeEvent,
  type SessionSnapshot,
  type SessionTraceStore,
  type ToolCall,
  type ToolDefinition,
  type WaveformLibrary,
} from '@dg-agent/core';
import { createEmptyOpossumState, type OpossumState } from '@dg-kit/protocol';
import { createDefaultOpossumPolicyRules, createDefaultPolicyRules } from '@dg-kit/safety';
import {
  DeviceCommandQueue,
  OpossumCommandQueue,
  OpossumPolicyEngine,
  PolicyEngine,
} from '@dg-kit/safety';
import type { OpossumClient, OpossumCommandResult } from './device-clients.js';
import { RuntimeToolExecutor, type DeviceExecutionGateInput } from './runtime-tool-executor.js';
import { createTurnState, type TurnState } from './runtime-turn-state.js';
import { resolveToolCallConfig, type ToolCallConfigInput } from './tool-call-config.js';
import { createDefaultToolRegistryWithDeps, type ToolRegistry } from './tool-registry.js';
import {
  VideoControlGrant,
  type VideoControlGrantInput,
  type VideoControlGrantSnapshot,
} from './video-control-grant.js';

const VIDEO_SESSION_ID = 'video-control-ephemeral';

export interface VideoControlSafetyLimits {
  maxStrengthA: number;
  maxStrengthB: number;
  maxColdStartStrength: number;
  maxAdjustStep: number;
  maxBurstDurationMs: number;
  maxBurstStrengthAbsolute: number;
  maxBurstStrengthRelative: number;
  maxIntensityA: number;
  maxIntensityB: number;
  maxColdStartIntensity: number;
  maxOpossumAdjustStep: number;
  maxToolIterations: number;
  maxToolCallsPerTurn: number;
  maxAdjustStrengthCallsPerTurn: number;
  maxBurstCallsPerTurn: number;
  maxVibrateAdjustCallsPerTurn: number;
  maxVibrateBurstCallsPerTurn: number;
  burstRequiresActiveChannel: boolean;
}

export interface VideoControlScene {
  name: string;
  prompt: string;
}

export interface VideoControlTargetRouter {
  /** Selects the exact live physical client and returns false for stale identities. */
  selectTarget(
    kind: VideoControlGrantSnapshot['targetKind'],
    targetId: string,
  ): boolean | Promise<boolean>;
  getCoyoteState(targetId: string): Promise<DeviceState | null>;
  getOpossumState(targetId: string): Promise<OpossumState | null>;
  executeCoyote(targetId: string, command: DeviceCommand): Promise<DeviceCommandResult | null>;
  executeOpossum(targetId: string, command: OpossumCommand): Promise<OpossumCommandResult | null>;
  /** Stops only that physical client; false means identity can no longer be proven. */
  stopTarget(
    kind: VideoControlGrantSnapshot['targetKind'],
    targetId: string,
  ): boolean | Promise<boolean>;
}

export interface VideoControlRuntimeOptions {
  device: DeviceClient;
  opossum: OpossumClient;
  getLlm: () => LlmClient | null;
  getSafetyLimits: () => VideoControlSafetyLimits;
  getScene?: () => VideoControlScene | null;
  hasLease: () => boolean;
  targetRouter: VideoControlTargetRouter;
  waveformLibrary?: WaveformLibrary;
  toolRegistry?: ToolRegistry;
  policyEngine?: PolicyEngine;
  opossumPolicyEngine?: OpossumPolicyEngine;
  permission?: PermissionService;
  toolCallConfig?: ToolCallConfigInput;
  now?: () => number;
  onRuntimeEvent?: (event: RuntimeEvent) => void;
  onEffectSettled?: (toolCall: ToolCall, output: string | null) => void;
}

/**
 * Ephemeral vision-to-device composition. It shares Agent's tool registry,
 * RuntimeToolExecutor, policy engines and command queues, while intentionally
 * omitting session/history/trace stores. One model observation may launch
 * effects, but never waits for those effects before accepting the next frame.
 */
export class VideoControlRuntime {
  private readonly now: () => number;
  private readonly queue: DeviceCommandQueue;
  private readonly opossumQueue: OpossumCommandQueue;
  private readonly runtimeDevice: DeviceClient;
  private readonly runtimeOpossum: OpossumClient;
  private readonly toolRegistry: ToolRegistry;
  private readonly toolExecutor: RuntimeToolExecutor;
  private grant: VideoControlGrant | null = null;
  private generation = 0;
  private stopsInFlight = 0;
  private emergencyLatched = false;
  private globalStopInProgress = false;
  private readonly lastStopTargets: Partial<
    Record<VideoControlGrantSnapshot['targetKind'], VideoControlGrantSnapshot>
  > = {};
  private activeInference: AbortController | null = null;
  private readonly effectControllers = new Set<AbortController>();
  private readonly effectGenerations = new Map<string, number>();
  private readonly session: SessionSnapshot = {
    id: VIDEO_SESSION_ID,
    createdAt: 0,
    updatedAt: 0,
    messages: [],
    deviceState: createEmptyDeviceState(),
  };

  constructor(private readonly options: VideoControlRuntimeOptions) {
    this.now = options.now ?? Date.now;
    this.session.createdAt = this.now();
    this.session.updatedAt = this.session.createdAt;
    this.runtimeDevice = this.createTargetedDeviceClient();
    this.runtimeOpossum = this.createTargetedOpossumClient();
    this.queue = new DeviceCommandQueue(this.runtimeDevice);
    this.opossumQueue = new OpossumCommandQueue(this.runtimeOpossum);
    const safety = options.getSafetyLimits();
    this.toolRegistry =
      options.toolRegistry ??
      createDefaultToolRegistryWithDeps({
        waveformLibrary: options.waveformLibrary,
        toolDefinitionHints: {
          maxColdStartStrength: safety.maxColdStartStrength,
          maxAdjustStrengthStep: safety.maxAdjustStep,
          maxAdjustStrengthCallsPerTurn: safety.maxAdjustStrengthCallsPerTurn,
          maxBurstDurationMs: safety.maxBurstDurationMs,
          maxBurstCallsPerTurn: safety.maxBurstCallsPerTurn,
          maxVibrateStartIntensity: safety.maxColdStartIntensity,
          maxVibrateAdjustStep: safety.maxOpossumAdjustStep,
          maxVibrateAdjustCallsPerTurn: safety.maxVibrateAdjustCallsPerTurn,
          maxVibrateBurstCallsPerTurn: safety.maxVibrateBurstCallsPerTurn,
        },
      });
    const policyEngine =
      options.policyEngine ??
      new PolicyEngine(
        createDefaultPolicyRules({
          maxStrengthA: safety.maxStrengthA,
          maxStrengthB: safety.maxStrengthB,
          maxColdStartStrength: safety.maxColdStartStrength,
          maxAdjustStep: safety.maxAdjustStep,
          maxBurstDurationMs: safety.maxBurstDurationMs,
          maxBurstStrengthAbsolute: safety.maxBurstStrengthAbsolute,
          maxBurstStrengthRelative: safety.maxBurstStrengthRelative,
        }),
      );
    const opossumPolicyEngine =
      options.opossumPolicyEngine ??
      new OpossumPolicyEngine(
        createDefaultOpossumPolicyRules({
          maxIntensityA: safety.maxIntensityA,
          maxIntensityB: safety.maxIntensityB,
          maxColdStartIntensity: safety.maxColdStartIntensity,
          maxAdjustStep: safety.maxOpossumAdjustStep,
        }),
      );
    const permission =
      options.permission ??
      ({ request: async () => ({ type: 'approve-scoped' as const }) } satisfies PermissionService);
    const toolCallConfig = resolveToolCallConfig({
      maxToolIterations: safety.maxToolIterations,
      maxToolCallsPerTurn: safety.maxToolCallsPerTurn,
      maxAdjustStrengthCallsPerTurn: safety.maxAdjustStrengthCallsPerTurn,
      maxBurstCallsPerTurn: safety.maxBurstCallsPerTurn,
      maxVibrateAdjustCallsPerTurn: safety.maxVibrateAdjustCallsPerTurn,
      maxVibrateBurstCallsPerTurn: safety.maxVibrateBurstCallsPerTurn,
      burstRequiresActiveChannel: safety.burstRequiresActiveChannel,
      ...options.toolCallConfig,
    });

    this.toolExecutor = new RuntimeToolExecutor({
      device: this.runtimeDevice,
      opossum: this.runtimeOpossum,
      permission,
      queue: this.queue,
      opossumQueue: this.opossumQueue,
      toolRegistry: this.toolRegistry,
      policyEngine,
      opossumPolicyEngine,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      toolCallConfig,
      emit: (event) => options.onRuntimeEvent?.(event),
      enqueueTimerTrigger: () => undefined,
      getSessionGeneration: () => this.generation,
      traceStore: NO_TRACE_STORE,
      deviceExecutionGate: (input) => this.canExecute(input),
    });
  }

  async authorize(input: VideoControlGrantInput): Promise<VideoControlGrantSnapshot> {
    const authorizationGeneration = this.generation;
    if (!(await this.options.targetRouter.selectTarget(input.targetKind, input.targetId))) {
      throw new Error('授权物理目标已断开或身份已失效');
    }
    if (authorizationGeneration !== this.generation) {
      throw new DOMException('Video authorization cancelled', 'AbortError');
    }
    const targetState =
      input.targetKind === 'coyote'
        ? await this.options.targetRouter.getCoyoteState(input.targetId)
        : await this.options.targetRouter.getOpossumState(input.targetId);
    if (authorizationGeneration !== this.generation) {
      throw new DOMException('Video authorization cancelled', 'AbortError');
    }
    if (!targetState?.connected) throw new Error('授权目标设备未连接');

    this.invalidateContinuations();
    this.grant?.revoke();
    const safety = this.options.getSafetyLimits();
    const safetyIntensityCap =
      input.targetKind === 'coyote'
        ? input.channel === 'A'
          ? safety.maxStrengthA
          : safety.maxStrengthB
        : input.channel === 'A'
          ? safety.maxIntensityA
          : safety.maxIntensityB;
    this.grant = new VideoControlGrant(input, { now: this.now, safetyIntensityCap });
    this.emergencyLatched = false;
    this.globalStopInProgress = false;
    return this.grant.getSnapshot();
  }

  getGrant(): VideoControlGrantSnapshot | null {
    return this.grant?.getSnapshot() ?? null;
  }

  isEmergencyLatched(): boolean {
    return this.emergencyLatched;
  }

  beginRun(): number {
    if (this.stopsInFlight > 0) throw new Error('正在确认设备已停止，请稍后继续');
    if (this.emergencyLatched) throw new Error('紧急停止已锁定，请重新授权后再开始');
    if (!this.grant?.isActive()) throw new Error('控制授权不存在或已过期');
    if (!this.options.hasLease()) throw new Error('Video 当前没有设备控制权');
    this.invalidateContinuations();
    return this.generation;
  }

  async observe(image: LlmImageInput, externalSignal?: AbortSignal): Promise<string> {
    if (this.activeInference) throw new Error('已有画面正在分析');
    if (this.emergencyLatched || !this.grant?.isActive() || !this.options.hasLease()) {
      throw new Error('控制授权不存在、已过期或已失去设备控制权');
    }
    const llm = this.options.getLlm();
    if (!llm?.capabilities?.imageInput) throw new Error('当前模型未声明图片输入能力');

    const generation = this.generation;
    const grant = this.grant.getSnapshot();
    const controller = new AbortController();
    this.activeInference = controller;
    const abort = () => controller.abort();
    externalSignal?.addEventListener('abort', abort, { once: true });

    try {
      this.session.deviceState = await this.runtimeDevice.getState();
      const definitions = narrowVideoToolDefinitions(
        await this.toolRegistry.listDefinitions(),
        grant,
      );
      const prompt = await this.buildObservationPrompt(grant);
      const context: ActionContext = {
        sessionId: VIDEO_SESSION_ID,
        sourceType: 'web',
        traceId: `video-${generation}-${this.now()}`,
      };
      const result = await llm.runTurn({
        session: this.session,
        message: prompt,
        context,
        instructions: buildVideoControlInstructions(this.options.getScene?.() ?? null, grant),
        tools: definitions,
        image,
        abortSignal: controller.signal,
        conversation: [{ kind: 'message', role: 'user', content: prompt }],
      });

      if (controller.signal.aborted || generation !== this.generation) {
        throw new DOMException('Video observation aborted', 'AbortError');
      }

      const allowedNames = new Set(definitions.map((definition) => definition.name));
      const toolCalls = (result.toolCalls ?? []).filter((toolCall) =>
        allowedNames.has(toolCall.name),
      );
      this.executeEffects(toolCalls, context, generation, createTurnState());
      return result.assistantMessage.trim() || '画面状态已更新';
    } finally {
      externalSignal?.removeEventListener('abort', abort);
      if (this.activeInference === controller) this.activeInference = null;
    }
  }

  /** Execute one already-targeted Video tool call and await the final safety boundary. */
  async executeAuthorizedTool(toolCall: ToolCall): Promise<string> {
    const generation = this.beginRun();
    const context: ActionContext = {
      sessionId: VIDEO_SESSION_ID,
      sourceType: 'web',
      traceId: `video-direct-${generation}-${this.now()}`,
    };
    this.effectGenerations.set(context.traceId, generation);
    try {
      return await this.toolExecutor.execute({
        session: this.session,
        toolCall,
        context,
        turnState: createTurnState(),
      });
    } finally {
      this.effectGenerations.delete(context.traceId);
    }
  }

  abortInference(): void {
    this.activeInference?.abort();
    this.activeInference = null;
  }

  async stop(
    reason:
      | 'pause'
      | 'stop'
      | 'hidden'
      | 'camera-ended'
      | 'device-loss'
      | 'grant-expired'
      | 'watchdog'
      | 'model-failures'
      | 'lease-loss'
      | 'unmount',
  ): Promise<void> {
    this.stopsInFlight += 1;
    try {
      const target = this.grant?.getSnapshot();
      this.invalidateContinuations();
      if (reason !== 'pause' && reason !== 'stop') this.grant?.revoke();
      try {
        await this.stopAuthorizedTarget(target);
      } catch (error) {
        this.emergencyLatched = true;
        this.grant?.revoke();
        let globalStopError: unknown;
        try {
          await this.stopAllTargets();
        } catch (stopError) {
          globalStopError = stopError;
        }
        if (globalStopError) throw globalStopError;
        if (error instanceof StaleVideoControlTargetError) return;
        throw error;
      }
    } finally {
      this.stopsInFlight -= 1;
    }
  }

  async emergencyStop(): Promise<void> {
    this.emergencyLatched = true;
    this.grant?.revoke();
    this.invalidateContinuations();
    // A Video emergency is global: another connected target may still contain
    // queued output even when the current grant names only one physical device.
    await this.stopAllTargets();
  }

  async dispose(): Promise<void> {
    await this.stop('unmount');
  }

  private createTargetedDeviceClient(): DeviceClient {
    const source = this.options.device;
    return {
      connect: () => source.connect(),
      disconnect: () => source.disconnect(),
      getState: async () => {
        const target = await this.targetForState('coyote');
        if (!target) return createEmptyDeviceState();
        const state = await this.options.targetRouter.getCoyoteState(target.targetId);
        if (!state) throw new StaleVideoControlTargetError();
        return state;
      },
      execute: async (command) => {
        const target = await this.selectActiveTarget('coyote');
        const result = await this.options.targetRouter.executeCoyote(target.targetId, command);
        if (!result) throw new StaleVideoControlTargetError();
        return result;
      },
      emergencyStop: async () => {
        if (this.globalStopInProgress) return source.emergencyStop();
        await this.stopLastTarget('coyote');
      },
      onStateChanged: (listener) => source.onStateChanged(listener),
    };
  }

  private createTargetedOpossumClient(): OpossumClient {
    const source = this.options.opossum;
    return {
      connect: () => source.connect(),
      disconnect: () => source.disconnect(),
      getState: async () => {
        const target = await this.targetForState('opossum');
        if (!target) return createEmptyOpossumState();
        const state = await this.options.targetRouter.getOpossumState(target.targetId);
        if (!state) throw new StaleVideoControlTargetError();
        return state;
      },
      execute: async (command) => {
        const target = await this.selectActiveTarget('opossum');
        const result = await this.options.targetRouter.executeOpossum(target.targetId, command);
        if (!result) throw new StaleVideoControlTargetError();
        return result;
      },
      emergencyStop: async () => {
        if (this.globalStopInProgress) return source.emergencyStop();
        await this.stopLastTarget('opossum');
      },
      setIndicatorColor: async () => {
        throw new Error('Video 不允许控制设备指示灯');
      },
      onStateChanged: (listener) => source.onStateChanged(listener),
      ...(source.subscribeButtons
        ? { subscribeButtons: (listener) => source.subscribeButtons!(listener) }
        : {}),
    };
  }

  private async selectActiveTarget(
    kind: VideoControlGrantSnapshot['targetKind'],
  ): Promise<VideoControlGrantSnapshot> {
    const grant = this.grant;
    if (!grant?.isActive()) throw new StaleVideoControlTargetError();
    const target = grant.getSnapshot();
    if (
      target.targetKind !== kind ||
      !(await this.options.targetRouter.selectTarget(kind, target.targetId))
    ) {
      throw new StaleVideoControlTargetError();
    }
    return target;
  }

  private async targetForState(
    kind: VideoControlGrantSnapshot['targetKind'],
  ): Promise<VideoControlGrantSnapshot | null> {
    if (this.globalStopInProgress) return null;
    const grant = this.grant;
    const activeTarget = grant?.isActive() ? grant.getSnapshot() : undefined;
    if (activeTarget && activeTarget.targetKind !== kind) return null;
    const target = activeTarget ?? this.lastStopTargets[kind];
    if (!target) return null;
    if (!(await this.options.targetRouter.selectTarget(kind, target.targetId))) {
      throw new StaleVideoControlTargetError();
    }
    return target;
  }

  private async stopLastTarget(kind: VideoControlGrantSnapshot['targetKind']): Promise<void> {
    const target = this.lastStopTargets[kind] ?? this.grant?.getSnapshot();
    if (
      !target ||
      target.targetKind !== kind ||
      !(await this.options.targetRouter.stopTarget(kind, target.targetId))
    ) {
      throw new StaleVideoControlTargetError();
    }
  }

  private invalidateContinuations(): void {
    this.generation += 1;
    this.abortInference();
    for (const controller of this.effectControllers) controller.abort();
    this.effectControllers.clear();
    this.effectGenerations.clear();
  }

  private executeEffects(
    toolCalls: ToolCall[],
    baseContext: ActionContext,
    generation: number,
    turnState: TurnState,
  ): void {
    if (toolCalls.length === 0) return;
    const controller = new AbortController();
    this.effectControllers.add(controller);
    void (async () => {
      for (const [index, toolCall] of toolCalls.entries()) {
        if (controller.signal.aborted || generation !== this.generation) break;
        const context = { ...baseContext, traceId: `${baseContext.traceId}-effect-${index}` };
        this.effectGenerations.set(context.traceId, generation);
        try {
          const output = await this.toolExecutor.execute({
            session: this.session,
            toolCall,
            context,
            turnState,
            abortSignal: controller.signal,
          });
          this.options.onEffectSettled?.(toolCall, output);
        } catch {
          this.options.onEffectSettled?.(toolCall, null);
        } finally {
          this.effectGenerations.delete(context.traceId);
        }
      }
    })().finally(() => {
      this.effectControllers.delete(controller);
    });
  }

  private async canExecute(input: DeviceExecutionGateInput): Promise<boolean> {
    const effectGeneration = this.effectGenerations.get(input.context.traceId);
    if (
      effectGeneration === undefined ||
      effectGeneration !== this.generation ||
      this.emergencyLatched ||
      !this.options.hasLease()
    ) {
      return false;
    }
    const grant = this.grant;
    if (!grant) return false;
    const safety = this.options.getSafetyLimits();
    const snapshot = grant.getSnapshot();
    if (
      input.deviceKind !== snapshot.targetKind ||
      !(await this.options.targetRouter.selectTarget(snapshot.targetKind, snapshot.targetId))
    ) {
      return false;
    }
    const intensityCap =
      snapshot.targetKind === 'coyote'
        ? snapshot.channel === 'A'
          ? safety.maxStrengthA
          : safety.maxStrengthB
        : snapshot.channel === 'A'
          ? safety.maxIntensityA
          : safety.maxIntensityB;
    return grant.allowsCommand(
      input,
      async () => {
        if (snapshot.targetKind === 'coyote') {
          const state = await this.runtimeDevice.getState();
          return snapshot.channel === 'A' ? state.strengthA : state.strengthB;
        }
        const state = await this.runtimeOpossum.getState();
        return snapshot.channel === 'A' ? state.intensityA : state.intensityB;
      },
      { intensityCap, maxBurstDurationMs: safety.maxBurstDurationMs },
    );
  }

  private async stopAuthorizedTarget(target: VideoControlGrantSnapshot | undefined): Promise<void> {
    if (!target) {
      await this.stopAllTargets();
      return;
    }
    this.lastStopTargets[target.targetKind] = target;
    await (target.targetKind === 'coyote'
      ? this.queue.emergencyStop()
      : this.opossumQueue.emergencyStop());
  }

  private async stopAllTargets(): Promise<void> {
    this.globalStopInProgress = true;
    const results = await Promise.allSettled([
      this.queue.emergencyStop(),
      this.opossumQueue.emergencyStop(),
    ]);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure) throw failure.reason;
  }

  private async buildObservationPrompt(grant: VideoControlGrantSnapshot): Promise<string> {
    if (!(await this.options.targetRouter.selectTarget(grant.targetKind, grant.targetId))) {
      throw new Error('授权物理目标已断开或身份已失效');
    }
    if (grant.targetKind === 'coyote') {
      const state = await this.runtimeDevice.getState();
      const value = grant.channel === 'A' ? state.strengthA : state.strengthB;
      return `观察最新画面并继续当前场景。当前授权目标：郊狼 ${grant.channel} 通道，当前强度 ${value}，授权上限 ${grant.intensityCap}。只依据画面中可见事实决定保持、降低、停止或推进。`;
    }
    const state = await this.runtimeOpossum.getState();
    const value = grant.channel === 'A' ? state.intensityA : state.intensityB;
    return `观察最新画面并继续当前场景。当前授权目标：负鼠 ${grant.channel} 通道，当前强度 ${value}，授权上限 ${grant.intensityCap}。只依据画面中可见事实决定保持、降低、停止或推进。`;
  }
}

export function buildVideoControlInstructions(
  scene: VideoControlScene | null,
  grant: VideoControlGrantSnapshot,
): string {
  const sceneText = scene
    ? `当前选定场景「${scene.name}」：\n${scene.prompt}`
    : '当前选定场景：温和、尊重边界地陪伴。';
  return `${sceneText}\n\n你是主动观察最新画面的场景主持者。每次只处理当前这一帧，不假设过去画面仍然成立。\n- 只依据画面里直接可见的姿态、动作、物体与变化；不得猜测身份、敏感属性或不可见意图。\n- 主动推进选定场景，语言自然简洁；可以使用已提供的控制能力，但绝不向用户暴露工具名、参数、协议、设备实现或内部判断过程。\n- 画面含糊、遮挡、无人或反馈不确定时，只保持、降低或停止，绝不提高。\n- 任何停止、拒绝、不适、危险或设备异常迹象拥有最高优先级：立即停止，不做替代推进。\n- 仅控制授权的 ${grant.targetKind === 'coyote' ? '郊狼' : '负鼠'} ${grant.channel} 通道，强度不得超过 ${grant.intensityCap}。${grant.allowEnhanced ? '允许小步增强。' : '不允许在启动后继续增强。'}${grant.allowBurst ? '允许安全策略范围内的短时脉冲。' : '禁止短时脉冲。'}`;
}

/** Reuses shared tool definitions and only narrows target-specific fields. */
export function narrowVideoToolDefinitions(
  definitions: ToolDefinition[],
  grant: VideoControlGrantSnapshot,
): ToolDefinition[] {
  const allowed =
    grant.targetKind === 'coyote'
      ? new Set([
          'shock_start',
          'shock_stop',
          'shock_adjust',
          'shock_change_wave',
          ...(grant.allowBurst ? ['shock_burst'] : []),
        ])
      : new Set([
          'vibrate_start',
          'vibrate_stop',
          'vibrate_adjust',
          'vibrate_change_pattern',
          ...(grant.allowBurst ? ['vibrate_burst'] : []),
        ]);

  return definitions.flatMap((definition) => {
    if (!allowed.has(definition.name)) return [];
    const parameters = definition.parameters as {
      properties?: Record<string, Record<string, unknown>>;
      required?: string[];
    };
    const properties = parameters.properties ?? {};
    const nextProperties = { ...properties };
    if (properties.channel) {
      nextProperties.channel = { ...properties.channel, enum: [grant.channel] };
    }
    for (const key of ['strength', 'intensity'] as const) {
      if (properties[key]) {
        nextProperties[key] = { ...properties[key], maximum: grant.intensityCap };
      }
    }
    if (properties.delta && !grant.allowEnhanced) {
      nextProperties.delta = { ...properties.delta, maximum: 0 };
    }
    const isStop = definition.name === 'shock_stop' || definition.name === 'vibrate_stop';
    return [
      {
        ...definition,
        parameters: {
          ...definition.parameters,
          properties: nextProperties,
          ...(isStop
            ? { required: [...new Set([...(parameters.required ?? []), 'channel'])] }
            : {}),
        },
      },
    ];
  });
}

class StaleVideoControlTargetError extends Error {
  constructor() {
    super('授权物理目标已断开或身份已失效');
    this.name = 'StaleVideoControlTargetError';
  }
}

const NO_TRACE_STORE: SessionTraceStore = {
  list: async () => [],
  append: async (_sessionId, entry) => ({
    ...entry,
    id: 'video-ephemeral-trace',
    createdAt: 0,
  }),
  clear: async () => undefined,
};
