import type { UnifiedOutputTarget } from '@0xnullai/device-runtime';
import type { LlmClient, LlmImageInput, ToolCall, ToolDefinition } from '@dg-agent/core';
import { guardUnverifiedActionClaim } from '@dg-agent/runtime';

export type VideoAiAllowedTarget = UnifiedOutputTarget & {
  capA: number;
  capB: number;
};

export interface VideoAiScene {
  name: string;
  prompt: string;
  /** Prompt without the opening conversation snapshot, for fresh per-message memory retrieval. */
  basePrompt?: string;
}

export interface VideoAiRoutingGrantInput {
  /** Server-owned private conversation; required by managed visual billing. */
  conversationId?: string;
  targets: readonly VideoAiAllowedTarget[];
  allowEnhanced: boolean;
  allowBurst: boolean;
  durationMs: number;
  cadenceMs: number;
  captureIntervalMs: number;
}

export interface VideoAiRoutingGrantSnapshot extends VideoAiRoutingGrantInput {
  issuedAt: number;
  expiresAt: number;
  revoked: boolean;
}

export interface VideoAiDeviceAction {
  id: string;
  target: VideoAiAllowedTarget;
  action: 'start' | 'adjust' | 'stop' | 'burst';
  channel: 'A' | 'B';
  value: number;
  durationMs: number;
}

interface Options {
  getLlm: () => LlmClient | null;
  getTargets: () => readonly UnifiedOutputTarget[];
  hasLease: () => boolean;
  invoke: (action: VideoAiDeviceAction, grant: VideoAiRoutingGrantSnapshot) => Promise<unknown>;
  stopAll: () => Promise<void>;
  now?: () => number;
}

/** One ephemeral, fail-closed allowlist spanning every Video output backend. */
export class VideoAiDeviceRouter {
  private grant: VideoAiRoutingGrantSnapshot | null = null;
  private generation = 0;
  private activeInference: AbortController | null = null;
  private stopInFlight: Promise<void> | null = null;
  private readonly ceilings = new Map<string, number>();
  private activeRoute: { target: VideoAiAllowedTarget; channel: 'A' | 'B' } | null = null;
  private readonly now: () => number;
  private llm: LlmClient | null = null;
  private targets: readonly UnifiedOutputTarget[] = [];
  private scene: VideoAiScene | null = null;
  private authorizedScene: VideoAiScene | null = null;
  private authorizedLlm: LlmClient | null = null;

  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
  }

  updateInputs(
    llm: LlmClient | null,
    targets: readonly UnifiedOutputTarget[],
    scene: VideoAiScene | null = null,
  ): void {
    this.llm = llm;
    this.targets = targets.map((target) => ({ ...target }));
    this.scene = scene ? { ...scene } : null;
  }

  async authorize(input: VideoAiRoutingGrantInput): Promise<VideoAiRoutingGrantSnapshot> {
    if (input.targets.length === 0) throw new Error('Video 至少需要一个已连接输出能力');
    if (this.stopInFlight) await this.stopInFlight;
    if (this.grant && !this.grant.revoked) await this.stop();
    const issuedAt = this.now();
    this.invalidate();
    this.ceilings.clear();
    // A shared Market selection may change in another panel while this camera
    // run is active. Keep every observation under the prompt authorized here.
    this.authorizedScene = this.scene ? { ...this.scene } : null;
    this.authorizedLlm = this.llm ?? this.options.getLlm();
    this.grant = {
      ...input,
      targets: input.targets.map((target) => ({ ...target })),
      durationMs: Math.min(15 * 60_000, Math.max(1_000, input.durationMs)),
      issuedAt,
      expiresAt: issuedAt + Math.min(15 * 60_000, Math.max(1_000, input.durationMs)),
      revoked: false,
    };
    return this.snapshot();
  }

  getGrant(): VideoAiRoutingGrantSnapshot | null {
    return this.grant ? this.snapshot() : null;
  }

  async observe(image: LlmImageInput, externalSignal?: AbortSignal): Promise<string> {
    if (!this.grant || this.grant.revoked) throw new Error('Video 控制授权不存在或已过期');
    if (this.now() >= this.grant.expiresAt) {
      await this.stop();
      throw new Error('Video 控制授权不存在或已过期');
    }
    const grant = this.grant;
    if (!this.options.hasLease()) {
      await this.stop();
      throw new Error('Video 当前没有设备控制权');
    }
    await this.assertAllowlistStillLive(grant);
    const llm = this.authorizedLlm;
    if (!llm?.capabilities?.imageInput) throw new Error('当前模型未声明图片输入能力');
    if (this.activeInference) throw new Error('已有画面正在分析');
    const generation = this.generation;
    const controller = new AbortController();
    this.activeInference = controller;
    const abort = () => controller.abort();
    externalSignal?.addEventListener('abort', abort, { once: true });
    try {
      const prompt = formatAllowedTargets(grant.targets);
      const sessionId = grant.conversationId ?? 'video-ai-routing-ephemeral';
      const result = await llm.runTurn({
        session: {
          id: sessionId,
          createdAt: grant.issuedAt,
          updatedAt: this.now(),
          messages: [],
          deviceState: {
            connected: false,
            battery: 0,
            strengthA: 0,
            strengthB: 0,
            limitA: 0,
            limitB: 0,
            waveActiveA: false,
            waveActiveB: false,
          },
        },
        message: prompt,
        context: {
          sessionId,
          sourceType: 'web',
          traceId: `video-route-${generation}-${this.now()}`,
        },
        instructions: buildVideoAiInstructions(this.authorizedScene),
        tools: [toolDefinition(grant)],
        image,
        abortSignal: controller.signal,
        conversation: [{ kind: 'message', role: 'user', content: prompt }],
      });
      if (controller.signal.aborted || generation !== this.generation) {
        throw new DOMException('Video observation aborted', 'AbortError');
      }
      await this.assertGrantCurrent(grant, generation);
      const calls = result.toolCalls ?? [];
      try {
        if (calls.some((call) => call.name !== 'video_device_control'))
          throw new Error('Video 模型请求了未授权的工具');
        for (const call of calls) await this.execute(call, grant, generation);
      } catch (error) {
        // Validation of a later call can fail after an earlier call started a
        // physical output. Any invalid batch must revoke the whole grant.
        if (!grant.revoked) await this.stop();
        throw error;
      }
      // The provider's pre-execution prose cannot describe the outcome of these calls.
      if (calls.length) return `已执行 ${calls.length} 项授权设备动作；请以设备实时状态为准。`;
      return guardUnverifiedActionClaim(result.assistantMessage.trim(), []) || '画面状态已更新';
    } finally {
      externalSignal?.removeEventListener('abort', abort);
      if (this.activeInference === controller) this.activeInference = null;
    }
  }

  /**
   * Revoke the grant and drop in-flight inference, with no device write. Lease loss uses this:
   * the lease owners already stopped every output, and `stop()` here would bypass the lease
   * fence and zero what the new holder starts.
   */
  revoke(): void {
    if (this.grant) this.grant.revoked = true;
    this.invalidate();
    this.authorizedLlm = null;
    this.activeRoute = null;
  }

  async stop(): Promise<void> {
    this.revoke();
    if (!this.stopInFlight) {
      const stopping = this.options.stopAll();
      this.stopInFlight = stopping;
      try {
        await stopping;
      } finally {
        if (this.stopInFlight === stopping) this.stopInFlight = null;
      }
      return;
    }
    await this.stopInFlight;
  }

  async emergencyStop(): Promise<void> {
    await this.stop();
  }

  private async execute(
    call: ToolCall,
    grant: VideoAiRoutingGrantSnapshot,
    generation: number,
  ): Promise<void> {
    await this.assertGrantCurrent(grant, generation);
    const args = parseAction(call, grant);
    await this.assertAllowlistStillLive(grant);
    await this.assertGrantCurrent(grant, generation);
    if (
      args.action !== 'stop' &&
      this.activeRoute &&
      (this.activeRoute.target.id !== args.target.id || this.activeRoute.channel !== args.channel)
    ) {
      const previousRoute = this.activeRoute;
      try {
        const stopResult = await this.options.invoke(
          {
            id: `${call.id}-switch-stop`,
            target: previousRoute.target,
            action: 'stop',
            channel: previousRoute.channel,
            value: 0,
            durationMs: 0,
          },
          grant,
        );
        assertAcceptedExecutionResult(stopResult, {
          ...args,
          target: previousRoute.target,
          action: 'stop',
          channel: previousRoute.channel,
        });
      } catch (error) {
        grant.revoked = true;
        this.invalidate();
        await this.options.stopAll();
        throw error;
      }
      this.activeRoute = null;
      await this.assertGrantCurrent(grant, generation);
    }
    const cap = args.channel === 'A' ? args.target.capA : args.target.capB;
    if (args.value > cap) throw new Error('模型请求超过授权上限');
    if (args.action === 'burst' && !grant.allowBurst) throw new Error('Video 未授权脉冲');
    if (args.action === 'adjust' && args.value > 0 && !grant.allowEnhanced) {
      throw new Error('Video 未授权增强');
    }
    const ceilingKey = `${args.target.id}:${args.channel}`;
    const ceiling = this.ceilings.get(ceilingKey);
    if (
      args.action === 'start' &&
      !grant.allowEnhanced &&
      ceiling !== undefined &&
      args.value > ceiling
    ) {
      throw new Error('Video 未授权停止后增强');
    }
    await this.assertGrantCurrent(grant, generation);
    try {
      const result = await this.options.invoke(args, grant);
      assertAcceptedExecutionResult(result, args);
    } catch (error) {
      grant.revoked = true;
      this.invalidate();
      await this.options.stopAll();
      throw error;
    }
    await this.assertGrantCurrent(grant, generation);
    if (args.action === 'stop') {
      if (
        this.activeRoute?.target.id === args.target.id &&
        this.activeRoute.channel === args.channel
      ) {
        this.activeRoute = null;
      }
    } else {
      this.activeRoute = { target: args.target, channel: args.channel };
    }
    if (args.action === 'start' && args.value > 0 && ceiling === undefined) {
      this.ceilings.set(ceilingKey, args.value);
    }
  }

  private async assertAllowlistStillLive(grant: VideoAiRoutingGrantSnapshot): Promise<void> {
    const liveTargets = this.targets.length > 0 ? this.targets : this.options.getTargets();
    const live = new Set(liveTargets.map(({ id }) => id));
    if (grant.targets.some(({ id }) => !live.has(id))) {
      grant.revoked = true;
      this.invalidate();
      await this.options.stopAll();
      throw new Error('Video 授权设备身份已变化或断开');
    }
  }

  private async assertGrantCurrent(
    grant: VideoAiRoutingGrantSnapshot,
    generation: number,
  ): Promise<void> {
    if (
      grant !== this.grant ||
      grant.revoked ||
      generation !== this.generation ||
      !this.options.hasLease() ||
      this.now() >= grant.expiresAt
    ) {
      if (grant === this.grant && !grant.revoked) await this.stop();
      throw new Error('Video 控制授权不存在、已过期或工作已失效');
    }
  }

  private snapshot(): VideoAiRoutingGrantSnapshot {
    return { ...this.grant!, targets: this.grant!.targets.map((target) => ({ ...target })) };
  }

  private invalidate(): void {
    this.generation += 1;
    this.activeInference?.abort();
    this.activeInference = null;
  }
}

function assertAcceptedExecutionResult(result: unknown, action: VideoAiDeviceAction): void {
  let parsed: unknown = result;
  if (typeof result === 'string') {
    try {
      parsed = JSON.parse(result);
    } catch {
      throw new Error('设备动作结果未确认');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('设备动作结果未确认');
  const value = parsed as Record<string, unknown>;
  if (typeof value.error === 'string') throw new Error(value.error);
  if (
    value._meta &&
    typeof value._meta === 'object' &&
    (value._meta as Record<string, unknown>).kind === 'tool-denied'
  )
    throw new Error('设备拒绝了 Video 动作');
  if (action.target.kind === 'embedded') {
    if (value.status === (action.action === 'stop' ? 'stopped' : 'applied')) return;
    throw new Error('设备动作结果未确认');
  }
  const command = value.command;
  const types: Record<VideoAiDeviceAction['action'], readonly string[]> = {
    start: ['start', 'vibrateStart'],
    adjust: ['adjustStrength', 'vibrateAdjust'],
    stop: ['stop', 'vibrateStop'],
    burst: ['burst', 'vibrateBurst'],
  };
  if (
    (value.ok === true || value.ok === 'clamped') &&
    (action.target.kind !== 'coyote' || value.targetId === action.target.targetId) &&
    command &&
    typeof command === 'object' &&
    !Array.isArray(command) &&
    types[action.action].includes(String((command as Record<string, unknown>).type))
  )
    return;
  throw new Error('设备动作结果未确认');
}

export function buildVideoAiInstructions(scene: VideoAiScene | null): string {
  const sceneText = scene ? `当前选定场景「${scene.name}」：\n${scene.prompt}\n\n` : '';
  return `${sceneText}你是连续观察最新画面的场景主持者，不等待用户逐轮下令；每次新帧只推进一小步。只依据当前画面决定是否控制，不假设上一帧仍成立。每次调用必须逐字使用已授权 targetId，不得猜测或改写身份。画面含糊、拒绝、不适、危险或设备异常时只停止，不得提高。工具请求不代表成功，只能根据真实执行结果叙述。`;
}

function toolDefinition(grant: VideoAiRoutingGrantSnapshot): ToolDefinition {
  const maxCap = Math.max(...grant.targets.flatMap((target) => [target.capA, target.capB]));
  return {
    name: 'video_device_control',
    description: 'Control or stop one exact output capability from the authorized Video snapshot.',
    parameters: {
      type: 'object',
      properties: {
        targetId: { type: 'string', enum: grant.targets.map(({ id }) => id) },
        action: { type: 'string', enum: ['start', 'adjust', 'stop', 'burst'] },
        channel: { type: 'string', enum: ['A', 'B'] },
        value: { type: 'number', minimum: -maxCap, maximum: maxCap },
        durationMs: { type: 'integer', minimum: 0, maximum: 5_000 },
      },
      required: ['targetId', 'action', 'channel'],
      additionalProperties: false,
    },
  };
}

function parseAction(call: ToolCall, grant: VideoAiRoutingGrantSnapshot): VideoAiDeviceAction {
  const { targetId, action, channel, value = 0, durationMs = 0 } = call.args;
  const target = grant.targets.find((candidate) => candidate.id === targetId);
  if (!target) throw new Error('模型请求了未授权 targetId');
  if (!['start', 'adjust', 'stop', 'burst'].includes(String(action)))
    throw new Error('未知设备动作');
  if (channel !== 'A' && channel !== 'B') throw new Error('无效通道');
  if (!Number.isFinite(value) || !Number.isSafeInteger(durationMs)) throw new Error('无效设备参数');
  if ((action === 'start' || action === 'burst') && Number(value) < 0) {
    throw new Error('启动或脉冲强度不能为负数');
  }
  if (target.kind === 'embedded' && action !== 'start' && action !== 'stop') {
    throw new Error('通用设备不支持该 Video 动作');
  }
  return {
    id: call.id,
    target,
    action: action as VideoAiDeviceAction['action'],
    channel,
    value: Number(value),
    durationMs: Number(durationMs),
  };
}

function formatAllowedTargets(targets: readonly VideoAiAllowedTarget[]): string {
  return `观察最新画面。已授权输出能力：\n${targets
    .map((target) => `${target.id} (${target.modality}, A<=${target.capA}, B<=${target.capB})`)
    .join('\n')}`;
}
