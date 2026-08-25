import type { UnifiedOutputTarget } from '@0xnullai/device-runtime';
import type { LlmClient, LlmImageInput, ToolCall, ToolDefinition } from '@dg-agent/core';

export type VideoAiAllowedTarget = UnifiedOutputTarget & {
  capA: number;
  capB: number;
};

export interface VideoAiRoutingGrantInput {
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
  private readonly ceilings = new Map<string, number>();
  private activeRoute: { target: VideoAiAllowedTarget; channel: 'A' | 'B' } | null = null;
  private readonly now: () => number;
  private llm: LlmClient | null = null;
  private targets: readonly UnifiedOutputTarget[] = [];

  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
  }

  updateInputs(llm: LlmClient | null, targets: readonly UnifiedOutputTarget[]): void {
    this.llm = llm;
    this.targets = targets.map((target) => ({ ...target }));
  }

  async authorize(input: VideoAiRoutingGrantInput): Promise<VideoAiRoutingGrantSnapshot> {
    if (input.targets.length === 0) throw new Error('Video 至少需要一个已连接输出能力');
    if (this.grant && !this.grant.revoked) await this.stop();
    const issuedAt = this.now();
    this.invalidate();
    this.ceilings.clear();
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
    const llm = this.llm ?? this.options.getLlm();
    if (!llm?.capabilities?.imageInput) throw new Error('当前模型未声明图片输入能力');
    if (this.activeInference) throw new Error('已有画面正在分析');
    const generation = this.generation;
    const controller = new AbortController();
    this.activeInference = controller;
    const abort = () => controller.abort();
    externalSignal?.addEventListener('abort', abort, { once: true });
    try {
      const prompt = formatAllowedTargets(grant.targets);
      const result = await llm.runTurn({
        session: {
          id: 'video-ai-routing-ephemeral',
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
          sessionId: 'video-ai-routing-ephemeral',
          sourceType: 'web',
          traceId: `video-route-${generation}-${this.now()}`,
        },
        instructions:
          '只依据最新画面决定是否控制。每次调用必须逐字使用已授权 targetId；不得猜测或改写身份。画面含糊、拒绝、不适或异常时只停止，不得提高。',
        tools: [toolDefinition(grant)],
        image,
        abortSignal: controller.signal,
        conversation: [{ kind: 'message', role: 'user', content: prompt }],
      });
      if (controller.signal.aborted || generation !== this.generation) {
        throw new DOMException('Video observation aborted', 'AbortError');
      }
      for (const call of result.toolCalls ?? []) {
        if (call.name !== 'video_device_control') continue;
        await this.execute(call, grant, generation);
      }
      return result.assistantMessage.trim() || '画面状态已更新';
    } finally {
      externalSignal?.removeEventListener('abort', abort);
      if (this.activeInference === controller) this.activeInference = null;
    }
  }

  async stop(): Promise<void> {
    if (this.grant) this.grant.revoked = true;
    this.invalidate();
    this.activeRoute = null;
    await this.options.stopAll();
  }

  async emergencyStop(): Promise<void> {
    await this.stop();
  }

  private async execute(
    call: ToolCall,
    grant: VideoAiRoutingGrantSnapshot,
    generation: number,
  ): Promise<void> {
    if (generation !== this.generation || !this.options.hasLease())
      throw new Error('Video 工作已失效');
    const args = parseAction(call, grant);
    await this.assertAllowlistStillLive(grant);
    if (
      args.action !== 'stop' &&
      this.activeRoute &&
      (this.activeRoute.target.id !== args.target.id || this.activeRoute.channel !== args.channel)
    ) {
      const previousRoute = this.activeRoute;
      try {
        await this.options.invoke(
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
      } catch (error) {
        grant.revoked = true;
        this.invalidate();
        await this.options.stopAll();
        throw error;
      }
      this.activeRoute = null;
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
    await this.options.invoke(args, grant);
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

  private snapshot(): VideoAiRoutingGrantSnapshot {
    return { ...this.grant!, targets: this.grant!.targets.map((target) => ({ ...target })) };
  }

  private invalidate(): void {
    this.generation += 1;
    this.activeInference?.abort();
    this.activeInference = null;
  }
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
