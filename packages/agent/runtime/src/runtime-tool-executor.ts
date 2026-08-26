import type {
  CoyoteTargetRouter,
  DeviceClient,
  Logger,
  PermissionService,
  SessionTraceStore,
} from '@dg-agent/core';
import {
  createExactCoyoteDeviceClient,
  isDeviceToolName,
  type ActionContext,
  type DeviceCommand,
  type DeviceKind,
  type OpossumCommand,
  type RuntimeEvent,
  type SessionSnapshot,
  type ToolCall,
  type ToolExecutionPlan,
} from '@dg-agent/core';
import type { CivetEdgingClient, OpossumClient, PawPrintsClient } from './device-clients.js';
import { DeviceCommandQueue, type OpossumCommandQueue } from '@dg-kit/safety';
import { throwIfAborted } from './runtime-errors.js';
import { consumeTurnQuota, type TurnState } from './runtime-turn-state.js';
import type { OpossumPolicyEngine, PolicyEngine } from '@dg-kit/safety';
import type { ToolCallConfig } from './tool-call-config.js';
import type { ToolRegistry } from './tool-registry.js';
import {
  filterToolDefinitionsByConnectedDevices,
  resolveRequiredDeviceKind,
} from './device-tool-availability.js';
import {
  POLICY_NOT_CONVERGED_REASON,
  POLICY_RESOLVE_MAX_ITERATIONS,
  resolvePolicyDecision,
} from './runtime-policy-resolution.js';

export { DEVICE_KIND_DISPLAY_NAME } from './device-clients.js';

// Keep the established module-level API stable while the pure availability
// policy lives in its own testable module.
export { filterToolDefinitionsByConnectedDevices, resolveRequiredDeviceKind };

interface ScheduledTimer {
  sessionId: string;
  timer: ReturnType<typeof setTimeout>;
  generation: number;
}

export interface TimerFiredTrigger {
  sessionId: string;
  label: string;
  seconds: number;
  firedAt: number;
  /** Runtime continuation generation captured when the timer was scheduled. */
  generation: number;
}

export interface DeviceExecutionGateInput {
  sessionId: string;
  context: ActionContext;
  deviceKind: DeviceKind;
  /** Exact connection-lifetime identity for Coyote commands. */
  targetId?: string;
  toolName: string;
  command: DeviceCommand | OpossumCommand | { type: 'setIndicatorColor'; color: number };
}

export type DeviceExecutionGate = (input: DeviceExecutionGateInput) => boolean | Promise<boolean>;

export interface RuntimeToolExecutorOptions {
  device: DeviceClient;
  coyoteTargetRouter?: CoyoteTargetRouter;
  opossum?: OpossumClient;
  pawPrints?: PawPrintsClient;
  civetEdging?: CivetEdgingClient;
  permission: PermissionService;
  queue: DeviceCommandQueue;
  opossumQueue?: OpossumCommandQueue;
  toolRegistry: ToolRegistry;
  policyEngine: PolicyEngine;
  opossumPolicyEngine: OpossumPolicyEngine;
  logger: Logger;
  toolCallConfig: ToolCallConfig;
  emit: (event: RuntimeEvent) => void;
  enqueueTimerTrigger: (trigger: TimerFiredTrigger) => void;
  getSessionGeneration: (sessionId: string) => number;
  traceStore: SessionTraceStore;
  /** Checked at the final transport boundary. Defaults to allow in AgentRuntime. */
  deviceExecutionGate: DeviceExecutionGate;
  /** Additional state-changing tools that must pass the existing upper permission service. */
  permissionRequiredToolNames?: ReadonlySet<string>;
}

export interface ExecuteToolCallInput {
  session: SessionSnapshot;
  toolCall: ToolCall;
  context: ActionContext;
  turnState: TurnState;
  abortSignal?: AbortSignal;
}

export class RuntimeToolExecutor {
  private readonly scheduledTimers = new Map<string, ScheduledTimer>();
  private readonly coyoteTargetQueues = new Map<string, DeviceCommandQueue>();

  constructor(private readonly options: RuntimeToolExecutorOptions) {}

  async execute(input: ExecuteToolCallInput): Promise<string> {
    const { session, toolCall, context, turnState, abortSignal } = input;
    const toolDisplayName = this.options.toolRegistry.getDisplayName(toolCall.name);
    const displayToolCall = toolDisplayName
      ? { ...toolCall, displayName: toolDisplayName }
      : toolCall;

    throwIfAborted(abortSignal);
    this.options.emit({
      type: 'tool-call-proposed',
      sessionId: session.id,
      toolCall: displayToolCall,
    });
    await this.options.traceStore.append(session.id, {
      kind: 'tool-call',
      turnId: context.traceId,
      sourceType: context.sourceType,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      toolDisplayName,
      args: toolCall.args,
    });

    const quotaError = consumeTurnQuota(
      toolCall.name,
      turnState,
      this.options.toolCallConfig,
      toolCall.args,
    );
    if (quotaError) {
      return this.denyToolCall(session, displayToolCall, quotaError, context);
    }

    if (isDeviceToolName(toolCall.name)) {
      const requiredKind = resolveRequiredDeviceKind(toolCall.name, toolCall.args);
      if (!requiredKind) {
        return this.denyToolCall(session, displayToolCall, '无法确定目标设备种类', context);
      }
      const connected = await this.isDeviceKindConnected(requiredKind, session);
      if (!connected) {
        return this.denyToolCall(session, displayToolCall, '设备未连接', context);
      }
    }

    // Generic runtime tools resolve to an inline plan because their own
    // fenced executor owns transport semantics. Ask through Agent's existing
    // permission service before registry resolution can invoke that executor.
    if (this.options.permissionRequiredToolNames?.has(toolCall.name)) {
      const permission = await this.options.permission.request({
        context,
        toolName: toolCall.name,
        toolDisplayName: toolDisplayName,
        summary: toolDisplayName ?? toolCall.name,
        args: toolCall.args,
      });
      throwIfAborted(abortSignal);
      if (permission.type === 'deny') {
        return this.denyToolCall(
          session,
          displayToolCall,
          permission.reason ?? '用户拒绝了本次工具调用',
          context,
        );
      }
    }

    const planResult = await this.resolvePlan(session.id, displayToolCall);
    if ('error' in planResult) {
      await this.options.traceStore.append(session.id, {
        kind: 'tool-denied',
        turnId: context.traceId,
        sourceType: context.sourceType,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        toolDisplayName,
        args: toolCall.args,
        detail: planResult.error,
      });
      return JSON.stringify({
        error: planResult.error,
        _meta: {
          kind: 'tool-denied',
          toolName: toolCall.name,
        },
      });
    }

    throwIfAborted(abortSignal);

    if (planResult.plan.type === 'timer') {
      return this.scheduleTimer(session, planResult.plan.command, context, displayToolCall);
    }

    if (planResult.plan.type === 'inline') {
      return this.recordInlineResult({
        session,
        toolCall: displayToolCall,
        context,
        plan: planResult.plan,
      });
    }

    if (planResult.plan.type === 'opossum') {
      return this.executeOpossumCommand({
        session,
        toolCall: displayToolCall,
        context,
        command: planResult.plan.command,
        abortSignal,
      });
    }

    if (planResult.plan.type === 'setIndicatorColor') {
      return this.executeSetIndicatorColor({
        session,
        toolCall: displayToolCall,
        context,
        deviceKind: planResult.plan.deviceKind,
        color: planResult.plan.color,
        abortSignal,
      });
    }

    return this.executeDeviceCommand({
      session,
      toolCall: displayToolCall,
      context,
      command: planResult.plan.command,
      abortSignal,
    });
  }

  /**
   * Checks connection state for whichever device kind a tool call actually
   * targets, instead of assuming "the device" always means Coyote. Also
   * preserves the old side effect of refreshing `session.deviceState` from
   * the live Coyote state, scoped now to only the coyote branch (the other
   * device kinds don't have a slot in `SessionSnapshot.deviceState`, which
   * stays Coyote-shaped by design).
   */
  /**
   * Which device kinds are connected right now. Public so `agent-runtime.ts`
   * can filter the tool list sent to the LLM before each turn, not just deny
   * a call after the fact — see `filterToolDefinitionsByConnectedDevices`.
   */
  async getConnectedDeviceKinds(session: SessionSnapshot): Promise<Set<DeviceKind>> {
    const connected = new Set<DeviceKind>();

    const coyoteTargets = await this.options.coyoteTargetRouter?.listTargets();
    const coyoteState = coyoteTargets?.[0]?.state ?? (await this.options.device.getState());
    session.deviceState = coyoteState;
    if (coyoteState.connected) connected.add('coyote');

    if (this.options.opossum && (await this.options.opossum.getState()).connected) {
      connected.add('opossum');
    }
    if (this.options.pawPrints && (await this.options.pawPrints.getState()).connected) {
      connected.add('paw-prints');
    }
    if (this.options.civetEdging && (await this.options.civetEdging.getState()).connected) {
      connected.add('civet-edging');
    }

    return connected;
  }

  private async isDeviceKindConnected(
    kind: DeviceKind,
    session: SessionSnapshot,
  ): Promise<boolean> {
    return (await this.getConnectedDeviceKinds(session)).has(kind);
  }

  private getIndicatorCapableClient(
    deviceKind: DeviceKind,
  ): { setIndicatorColor(color: number): Promise<void> } | null {
    switch (deviceKind) {
      case 'paw-prints': {
        const client = this.options.pawPrints;
        return client?.setIndicatorColor
          ? { setIndicatorColor: (c) => client.setIndicatorColor!(c) }
          : null;
      }
      case 'civet-edging': {
        const client = this.options.civetEdging;
        return client?.setIndicatorColor
          ? { setIndicatorColor: (c) => client.setIndicatorColor!(c) }
          : null;
      }
      case 'opossum':
        return this.options.opossum ?? null;
      default:
        return null;
    }
  }

  private async recordInlineResult(input: {
    session: SessionSnapshot;
    toolCall: ToolCall;
    context: ActionContext;
    plan: Extract<ToolExecutionPlan, { type: 'inline' }>;
  }): Promise<string> {
    const { session, toolCall, context, plan } = input;
    this.options.emit({
      type: 'tool-call-executing',
      sessionId: session.id,
      toolCall,
    });
    await this.options.traceStore.append(session.id, {
      kind: 'tool-result',
      turnId: context.traceId,
      sourceType: context.sourceType,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      toolDisplayName: toolCall.displayName,
      args: toolCall.args,
      output: plan.output,
    });
    return plan.output;
  }

  cancelScheduledTimers(sessionId?: string): void {
    for (const [timerId, scheduled] of this.scheduledTimers.entries()) {
      if (sessionId && scheduled.sessionId !== sessionId) continue;
      clearTimeout(scheduled.timer);
      this.scheduledTimers.delete(timerId);
    }
  }

  /** Invalidates queued/in-flight exact-target work before the aggregate emergency stop returns. */
  async emergencyStopCoyoteTargetQueues(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.coyoteTargetQueues.values()].map((queue) => queue.emergencyStop()),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure) throw failure.reason;
  }

  private async resolvePlan(
    sessionId: string,
    toolCall: ToolCall,
  ): Promise<{ plan: ToolExecutionPlan } | { error: string }> {
    try {
      return {
        plan: await this.options.toolRegistry.resolve(toolCall),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.options.emit({
        type: 'tool-call-denied',
        sessionId,
        toolCall,
        reason,
      });
      return { error: reason };
    }
  }

  private async scheduleTimer(
    session: SessionSnapshot,
    command: Extract<ToolExecutionPlan, { type: 'timer' }>['command'],
    context: ActionContext,
    toolCall: ToolCall,
  ): Promise<string> {
    this.options.emit({
      type: 'tool-call-executing',
      sessionId: session.id,
      toolCall,
    });
    const dueAt = Date.now() + command.seconds * 1000;
    const timerId = `${session.id}:${command.label}:${dueAt}`;
    const generation = this.options.getSessionGeneration(session.id);
    const timer = setTimeout(() => {
      const firedAt = Date.now();
      this.scheduledTimers.delete(timerId);
      this.options.emit({
        type: 'timer-fired',
        sessionId: session.id,
        label: command.label,
        firedAt,
      });
      this.options.enqueueTimerTrigger({
        sessionId: session.id,
        label: command.label,
        seconds: command.seconds,
        firedAt,
        generation,
      });
    }, command.seconds * 1000);
    this.scheduledTimers.set(timerId, {
      sessionId: session.id,
      timer,
      generation,
    });
    await this.options.traceStore.append(session.id, {
      kind: 'timer-scheduled',
      turnId: context.traceId,
      sourceType: context.sourceType,
      label: command.label,
      seconds: command.seconds,
      dueAt,
    });

    this.options.emit({
      type: 'timer-scheduled',
      sessionId: session.id,
      label: command.label,
      dueAt,
    });

    return JSON.stringify({
      timer: {
        id: timerId,
        label: command.label,
        seconds: command.seconds,
        dueAt,
      },
    });
  }

  private async executeOpossumCommand(input: {
    session: SessionSnapshot;
    toolCall: ToolCall;
    context: ActionContext;
    command: OpossumCommand;
    abortSignal?: AbortSignal;
  }): Promise<string> {
    const { session, toolCall, context, abortSignal } = input;
    let { command } = input;

    if (!this.options.opossum || !this.options.opossumQueue) {
      return this.denyToolCall(session, toolCall, '设备未连接', context);
    }
    const opossum = this.options.opossum;
    const opossumQueue = this.options.opossumQueue;

    throwIfAborted(abortSignal);
    const currentState = await opossum.getState();

    const resolution = resolvePolicyDecision(command, POLICY_RESOLVE_MAX_ITERATIONS, (cmd) =>
      this.options.opossumPolicyEngine.evaluate({
        context,
        command: cmd,
        deviceState: currentState,
      }),
    );
    command = resolution.command;
    const { clampedFrom, needsConfirm, confirmReason } = resolution;

    if (clampedFrom) {
      this.options.logger.warn('Opossum command clamped by policy.', {
        sessionId: session.id,
        toolName: toolCall.name,
        reason: clampedFrom.reason,
      });
    }

    if (resolution.exhausted) {
      this.options.logger.error('Opossum policy clamp loop did not converge.', {
        sessionId: session.id,
        toolName: toolCall.name,
        clampReasons: resolution.clampReasons,
      });
      return this.denyToolCall(session, toolCall, POLICY_NOT_CONVERGED_REASON, context);
    }

    if (resolution.denyReason !== undefined) {
      return this.denyToolCall(session, toolCall, resolution.denyReason, context);
    }

    if (needsConfirm) {
      const permission = await this.options.permission.request({
        context,
        toolName: toolCall.name,
        toolDisplayName: toolCall.displayName,
        summary: toolCall.displayName ?? toolCall.name,
        args: toolCall.args,
      });

      throwIfAborted(abortSignal);

      if (permission.type === 'deny') {
        return this.denyToolCall(session, toolCall, permission.reason ?? confirmReason, context);
      }
    }

    throwIfAborted(abortSignal);
    if (!(await this.canExecuteDeviceCommand(session, context, toolCall, 'opossum', command))) {
      return this.denyToolCall(session, toolCall, '当前模块已失去设备控制权', context);
    }
    throwIfAborted(abortSignal);

    this.options.emit({
      type: 'tool-call-executing',
      sessionId: session.id,
      toolCall,
    });

    try {
      const result = await opossumQueue.enqueue(command);

      const output = JSON.stringify({
        ok: clampedFrom ? 'clamped' : true,
        command,
        state: result.state,
        ...(clampedFrom
          ? {
              clampedFrom: clampedFrom.command,
              _warning: `策略限制：原始命令被调整为上面的 command。回复用户时请按实际执行值（command 字段）说明，不要按原始请求复述。原因：${clampedFrom.reason}`,
            }
          : {}),
        _hint: '以上 state 是负鼠设备当前真实状态，请根据此状态回复用户。',
      });
      await this.options.traceStore.append(session.id, {
        kind: 'tool-result',
        turnId: context.traceId,
        sourceType: context.sourceType,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        toolDisplayName: toolCall.displayName,
        args: toolCall.args,
        output,
      });
      return output;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.options.emit({
        type: 'tool-call-failed',
        sessionId: session.id,
        toolCall,
        error: reason,
      });
      await this.options.traceStore.append(session.id, {
        kind: 'tool-failed',
        turnId: context.traceId,
        sourceType: context.sourceType,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        toolDisplayName: toolCall.displayName,
        args: toolCall.args,
        detail: reason,
      });
      return JSON.stringify({
        error: reason,
        _meta: {
          kind: 'tool-failed',
          toolName: toolCall.name,
        },
      });
    }
  }

  private async executeSetIndicatorColor(input: {
    session: SessionSnapshot;
    toolCall: ToolCall;
    context: ActionContext;
    deviceKind: DeviceKind;
    color: number;
    abortSignal?: AbortSignal;
  }): Promise<string> {
    const { session, toolCall, context, deviceKind, color, abortSignal } = input;
    const client = this.getIndicatorCapableClient(deviceKind);
    if (!client) {
      return this.denyToolCall(session, toolCall, '设备未连接', context);
    }

    throwIfAborted(abortSignal);
    if (
      !(await this.canExecuteDeviceCommand(session, context, toolCall, deviceKind, {
        type: 'setIndicatorColor',
        color,
      }))
    ) {
      return this.denyToolCall(session, toolCall, '当前模块已失去设备控制权', context);
    }
    throwIfAborted(abortSignal);

    this.options.emit({
      type: 'tool-call-executing',
      sessionId: session.id,
      toolCall,
    });

    try {
      await client.setIndicatorColor(color);
      const output = JSON.stringify({
        ok: true,
        deviceKind,
        color,
        _hint: '指示灯颜色已更新，纯外观变化，不影响强度/振动输出。',
      });
      await this.options.traceStore.append(session.id, {
        kind: 'tool-result',
        turnId: context.traceId,
        sourceType: context.sourceType,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        toolDisplayName: toolCall.displayName,
        args: toolCall.args,
        output,
      });
      return output;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.options.emit({
        type: 'tool-call-failed',
        sessionId: session.id,
        toolCall,
        error: reason,
      });
      await this.options.traceStore.append(session.id, {
        kind: 'tool-failed',
        turnId: context.traceId,
        sourceType: context.sourceType,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        toolDisplayName: toolCall.displayName,
        args: toolCall.args,
        detail: reason,
      });
      return JSON.stringify({
        error: reason,
        _meta: {
          kind: 'tool-failed',
          toolName: toolCall.name,
        },
      });
    }
  }

  private async executeDeviceCommand(input: {
    session: SessionSnapshot;
    toolCall: ToolCall;
    context: ActionContext;
    command: DeviceCommand;
    abortSignal?: AbortSignal;
  }): Promise<string> {
    const { session, toolCall, context, abortSignal } = input;
    let { command } = input;

    throwIfAborted(abortSignal);

    const targetId = this.options.coyoteTargetRouter ? readExactTargetId(toolCall.args) : null;
    if (this.options.coyoteTargetRouter && !targetId) {
      return this.denyToolCall(session, toolCall, '缺少有效的郊狼 targetId', context);
    }
    const currentState = targetId
      ? await this.options.coyoteTargetRouter!.getTargetState(targetId)
      : await this.options.device.getState();
    if (!currentState?.connected) {
      return this.denyToolCall(session, toolCall, '目标郊狼未连接或身份已失效', context);
    }
    const burstError = validateBurstExecution(command, currentState, this.options.toolCallConfig);
    if (burstError) {
      return this.denyToolCall(session, toolCall, burstError, context);
    }

    const initialCommand = command;
    const resolution = resolvePolicyDecision(command, POLICY_RESOLVE_MAX_ITERATIONS, (cmd) =>
      this.options.policyEngine.evaluate({ context, command: cmd, deviceState: currentState }),
    );
    command = resolution.command;
    const { clampedFrom, needsConfirm, confirmReason } = resolution;

    if (clampedFrom) {
      this.options.logger.warn('Command clamped by policy.', {
        sessionId: session.id,
        toolName: toolCall.name,
        reason: clampedFrom.reason,
      });
      this.options.emit({
        type: 'tool-call-clamped',
        sessionId: session.id,
        toolCall,
        originalCommand: initialCommand,
        adjustedCommand: command,
        reason: clampedFrom.reason,
      });
    }

    if (resolution.exhausted) {
      this.options.logger.error('Policy clamp loop did not converge.', {
        sessionId: session.id,
        toolName: toolCall.name,
        clampReasons: resolution.clampReasons,
      });
      return this.denyToolCall(session, toolCall, POLICY_NOT_CONVERGED_REASON, context);
    }

    if (resolution.denyReason !== undefined) {
      return this.denyToolCall(session, toolCall, resolution.denyReason, context);
    }

    if (needsConfirm) {
      const permission = await this.options.permission.request({
        context,
        toolName: toolCall.name,
        toolDisplayName: toolCall.displayName,
        summary:
          this.options.toolRegistry.summarizeCommand(toolCall.name, command) ??
          toolCall.displayName ??
          toolCall.name,
        args: toolCall.args,
      });

      throwIfAborted(abortSignal);

      if (permission.type === 'deny') {
        return this.denyToolCall(session, toolCall, permission.reason ?? confirmReason, context);
      }
    }

    throwIfAborted(abortSignal);
    if (
      !(await this.canExecuteDeviceCommand(
        session,
        context,
        toolCall,
        'coyote',
        command,
        targetId ?? undefined,
      ))
    ) {
      return this.denyToolCall(session, toolCall, '当前模块已失去设备控制权', context);
    }
    throwIfAborted(abortSignal);

    this.options.emit({
      type: 'tool-call-executing',
      sessionId: session.id,
      toolCall,
      command,
      ...(clampedFrom ? { clampedFrom } : {}),
    });

    try {
      const result = targetId
        ? await this.getCoyoteTargetQueue(targetId).enqueue(command)
        : await this.options.queue.enqueue(command);
      session.deviceState = result.state;

      this.options.emit({
        type: 'device-command-executed',
        sessionId: session.id,
        command,
        result,
      });

      const baseNotes = result.notes ?? [];
      const notes = clampedFrom
        ? [...baseNotes, `policy-clamped: ${clampedFrom.reason}`]
        : baseNotes;

      const output = JSON.stringify({
        ok: clampedFrom ? 'clamped' : true,
        command,
        state: result.state,
        notes,
        ...(clampedFrom
          ? {
              clampedFrom: clampedFrom.command,
              _warning: `策略限制：原始命令被调整为上面的 command。回复用户时请按实际执行值（command 字段）说明，不要按原始请求复述。原因：${clampedFrom.reason}`,
            }
          : {}),
        _hint: '以上 state 是设备当前真实状态，请根据此状态回复用户。',
      });
      await this.options.traceStore.append(session.id, {
        kind: 'tool-result',
        turnId: context.traceId,
        sourceType: context.sourceType,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        toolDisplayName: toolCall.displayName,
        args: toolCall.args,
        output,
      });
      return output;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.options.emit({
        type: 'tool-call-failed',
        sessionId: session.id,
        toolCall,
        error: reason,
      });
      await this.options.traceStore.append(session.id, {
        kind: 'tool-failed',
        turnId: context.traceId,
        sourceType: context.sourceType,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        toolDisplayName: toolCall.displayName,
        args: toolCall.args,
        detail: reason,
      });
      return JSON.stringify({
        error: reason,
        _meta: {
          kind: 'tool-failed',
          toolName: toolCall.name,
        },
      });
    }
  }

  private getCoyoteTargetQueue(targetId: string): DeviceCommandQueue {
    const existing = this.coyoteTargetQueues.get(targetId);
    if (existing) return existing;
    const router = this.options.coyoteTargetRouter!;
    const exactClient = createExactCoyoteDeviceClient(router, targetId);
    const queue = new DeviceCommandQueue(exactClient);
    this.coyoteTargetQueues.set(targetId, queue);
    return queue;
  }

  private async canExecuteDeviceCommand(
    session: SessionSnapshot,
    context: ActionContext,
    toolCall: ToolCall,
    deviceKind: DeviceKind,
    command: DeviceExecutionGateInput['command'],
    targetId?: string,
  ): Promise<boolean> {
    // Lease loss must never make a stop path unreachable.
    if (
      command.type === 'stop' ||
      command.type === 'emergencyStop' ||
      command.type === 'vibrateStop'
    ) {
      return true;
    }
    return this.options.deviceExecutionGate({
      sessionId: session.id,
      context,
      deviceKind,
      targetId,
      toolName: toolCall.name,
      command,
    });
  }

  private async denyToolCall(
    session: SessionSnapshot,
    toolCall: ToolCall,
    reason: string,
    context: ActionContext,
  ): Promise<string> {
    this.options.emit({
      type: 'tool-call-denied',
      sessionId: session.id,
      toolCall,
      reason,
    });
    await this.options.traceStore.append(session.id, {
      kind: 'tool-denied',
      turnId: context.traceId,
      sourceType: context.sourceType,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      toolDisplayName: toolCall.displayName,
      args: toolCall.args,
      detail: reason,
    });
    return JSON.stringify({
      error: reason,
      _meta: {
        kind: 'tool-denied',
        toolName: toolCall.name,
      },
    });
  }
}

function readExactTargetId(args: Record<string, unknown>): string | null {
  const value = args.targetId;
  return typeof value === 'string' && value.trim() ? value : null;
}

function validateBurstExecution(
  command: DeviceCommand,
  deviceState: SessionSnapshot['deviceState'],
  config: ToolCallConfig,
): string | null {
  if (command.type !== 'burst' || !config.burstRequiresActiveChannel) return null;

  const current = command.channel === 'A' ? deviceState.strengthA : deviceState.strengthB;
  const waveActive = command.channel === 'A' ? deviceState.waveActiveA : deviceState.waveActiveB;
  if (current > 0 && waveActive) return null;

  return `当前通道 ${command.channel} 还没有运行（strength=${current}, waveActive=${waveActive}），不能直接执行 burst，请先启动通道`;
}
