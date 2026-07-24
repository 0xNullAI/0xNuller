/**
 * Executes a resolved `ToolExecutionPlan` against the safety chain:
 * connection check → policy evaluation (with clamp re-entry, since a clamp
 * can unlock a later rule like `permission-gate`) → permission → serial
 * command queue. Quota is NOT handled here — the `ToolRegistry` is
 * constructed with `createSlidingWindowRateLimitPolicy`, so it's already
 * enforced inside `registry.resolve()` before a plan is ever returned.
 *
 * Deliberately does not attempt `filterToolDefinitionsByConnectedDevices`
 * (DG-Agent's approach of hiding tools for disconnected devices) — the
 * realtime session declares all tools once at connect time and most
 * providers can't update the tool list mid-session, so unconnected devices
 * are instead denied here with a clear reason, which becomes the model's
 * own signal not to retry.
 */
import type {
  DeviceCommand,
  DeviceKind,
  DeviceState,
  OpossumCommand,
  ToolCall,
  ToolExecutionPlan,
} from '@dg-kit/core';
import type { OpossumState } from '@dg-kit/protocol';
import type { ToolRegistry } from '@dg-kit/tools';
import type { OpossumPolicyEngine, PolicyEngine } from './policy-engine.js';
import type { DeviceCommandQueue, OpossumCommandQueue } from './device-command-queue.js';
import type { DeviceSession } from './device-session.js';
import type { ActionContext, PermissionService } from './types.js';

const POLICY_RESOLVE_MAX_ITERATIONS = 4;

export interface ToolExecutorOptions {
  session: DeviceSession;
  registry: ToolRegistry;
  policyEngine: PolicyEngine;
  opossumPolicyEngine: OpossumPolicyEngine;
  permission: PermissionService;
  deviceQueue: DeviceCommandQueue;
  opossumQueue: OpossumCommandQueue;
  context: ActionContext;
}

export interface ToolExecutionResult {
  toolCallId: string;
  output: string;
}

const DEVICE_KIND_DISPLAY_NAME: Record<DeviceKind, string> = {
  coyote: '郊狼',
  'paw-prints': '爪印',
  'civet-edging': '灵猫',
  opossum: '负鼠',
};

const SHOCK_TOOL_NAMES = new Set([
  'shock_start',
  'shock_stop',
  'shock_adjust',
  'shock_change_wave',
  'shock_burst',
  // pre-1.9.0 aliases
  'start',
  'stop',
  'adjust_strength',
  'change_wave',
  'burst',
]);
const VIBRATE_TOOL_NAMES = new Set([
  'vibrate_start',
  'vibrate_stop',
  'vibrate_adjust',
  'vibrate_change_pattern',
  'vibrate_burst',
]);

function resolveRequiredDeviceKind(toolName: string, args: Record<string, unknown>): DeviceKind | null {
  if (SHOCK_TOOL_NAMES.has(toolName)) return 'coyote';
  if (VIBRATE_TOOL_NAMES.has(toolName)) return 'opossum';
  if (toolName === 'set_indicator_color') {
    const kind = args.deviceKind;
    return kind === 'paw-prints' || kind === 'civet-edging' || kind === 'opossum' ? kind : null;
  }
  return null;
}

export class ToolExecutor {
  constructor(private readonly options: ToolExecutorOptions) {}

  async execute(toolCall: ToolCall): Promise<ToolExecutionResult> {
    const output = await this.resolveAndRun(toolCall);
    return { toolCallId: toolCall.id, output };
  }

  private async resolveAndRun(toolCall: ToolCall): Promise<string> {
    const requiredKind = resolveRequiredDeviceKind(toolCall.name, toolCall.args);
    if (requiredKind) {
      const connected = await this.isKindConnected(requiredKind);
      if (!connected) {
        return this.deny(`${DEVICE_KIND_DISPLAY_NAME[requiredKind]}未连接`);
      }
    }

    let plan: ToolExecutionPlan;
    try {
      plan = await this.options.registry.resolve(toolCall);
    } catch (error) {
      return this.deny(error instanceof Error ? error.message : String(error));
    }

    switch (plan.type) {
      case 'device':
        return this.executeDeviceCommand(plan.command);
      case 'opossum':
        return this.executeOpossumCommand(plan.command);
      case 'setIndicatorColor':
        return this.executeSetIndicatorColor(plan.deviceKind, plan.color);
      case 'inline':
        return JSON.stringify({ ok: true, output: plan.output, summary: plan.summary });
      case 'timer':
        // Realtime voice has no multi-turn scheduling loop to fire this
        // back into (there is no "next turn" the way a chat runtime has) —
        // surface a clear denial rather than silently accepting it.
        return this.deny('当前语音模式不支持定时器，请直接口头提醒');
      default: {
        const exhaustive: never = plan;
        return this.deny(`未知的执行计划：${JSON.stringify(exhaustive)}`);
      }
    }
  }

  private async isKindConnected(kind: DeviceKind): Promise<boolean> {
    const state = await this.options.session.getState();
    switch (kind) {
      case 'coyote':
        return state.coyote.connected;
      case 'opossum':
        return state.opossum.connected;
      case 'paw-prints':
        return state.pawPrints.connected;
      case 'civet-edging':
        return state.civetEdging.connected;
    }
  }

  private async executeDeviceCommand(command: DeviceCommand): Promise<string> {
    const deviceState = await this.options.session.coyote.getState();
    const resolved = await this.resolvePolicy(deviceState, command);
    if (resolved.type === 'deny') return this.deny(resolved.reason);

    if (resolved.type === 'require-confirm') {
      const decision = await this.options.permission.request({
        context: this.options.context,
        toolName: command.type,
        summary: `执行 ${command.type}`,
        args: command as unknown as Record<string, unknown>,
      });
      if (decision.type === 'deny') {
        return this.deny(decision.reason ?? '用户拒绝了本次操作');
      }
    }

    try {
      const result = await this.options.deviceQueue.enqueue(resolved.command);
      return JSON.stringify({
        ok: resolved.clampedFrom ? 'clamped' : true,
        command: resolved.command,
        state: result.state,
        ...(resolved.clampedFrom
          ? {
              clampedFrom: resolved.clampedFrom.command,
              _warning: `策略限制：原始命令被调整。回复用户时请按实际执行值（command 字段）说明，不要按原始请求复述。原因：${resolved.clampedFrom.reason}`,
            }
          : {}),
        _hint: '以上 state 是设备当前真实状态，请据此回复用户。',
      });
    } catch (error) {
      return this.fail(error);
    }
  }

  private async executeOpossumCommand(command: OpossumCommand): Promise<string> {
    const deviceState = await this.options.session.opossum.getState();
    const resolved = await this.resolveOpossumPolicy(deviceState, command);
    if (resolved.type === 'deny') return this.deny(resolved.reason);

    if (resolved.type === 'require-confirm') {
      const decision = await this.options.permission.request({
        context: this.options.context,
        toolName: command.type,
        summary: `执行 ${command.type}`,
        args: command as unknown as Record<string, unknown>,
      });
      if (decision.type === 'deny') {
        return this.deny(decision.reason ?? '用户拒绝了本次操作');
      }
    }

    try {
      const result = await this.options.opossumQueue.enqueue(resolved.command);
      return JSON.stringify({
        ok: resolved.clampedFrom ? 'clamped' : true,
        command: resolved.command,
        state: result.state,
        ...(resolved.clampedFrom
          ? {
              clampedFrom: resolved.clampedFrom.command,
              _warning: `策略限制：原始命令被调整。回复用户时请按实际执行值（command 字段）说明。原因：${resolved.clampedFrom.reason}`,
            }
          : {}),
        _hint: '以上 state 是负鼠设备当前真实状态，请据此回复用户。',
      });
    } catch (error) {
      return this.fail(error);
    }
  }

  private async executeSetIndicatorColor(deviceKind: DeviceKind, color: number): Promise<string> {
    const client =
      deviceKind === 'opossum'
        ? this.options.session.opossum
        : deviceKind === 'paw-prints'
          ? this.options.session.pawPrints
          : deviceKind === 'civet-edging'
            ? this.options.session.civetEdging
            : null;
    if (!client?.setIndicatorColor) {
      return this.deny(`${DEVICE_KIND_DISPLAY_NAME[deviceKind]}未连接`);
    }
    try {
      await client.setIndicatorColor(color);
      return JSON.stringify({
        ok: true,
        deviceKind,
        color,
        _hint: '指示灯颜色已更新，纯外观变化，不影响强度/振动输出。',
      });
    } catch (error) {
      return this.fail(error);
    }
  }

  /** Re-evaluates after each clamp so a clamp can't short-circuit a later `require-confirm` rule. */
  private async resolvePolicy(
    deviceState: DeviceState,
    command: DeviceCommand,
  ): Promise<
    | { type: 'deny'; reason: string }
    | {
        type: 'ok' | 'require-confirm';
        command: DeviceCommand;
        clampedFrom?: { command: DeviceCommand; reason: string };
      }
  > {
    let current = command;
    let clampedFrom: { command: typeof command; reason: string } | undefined;

    for (let i = 0; i < POLICY_RESOLVE_MAX_ITERATIONS; i++) {
      const decision = this.options.policyEngine.evaluate({
        context: this.options.context,
        command: current,
        deviceState,
      });
      if (decision.type === 'deny') return { type: 'deny', reason: decision.reason };
      if (decision.type === 'clamp') {
        clampedFrom = clampedFrom ?? { command, reason: decision.reason };
        current = decision.command;
        continue;
      }
      if (decision.type === 'require-confirm') {
        return { type: 'require-confirm', command: current, clampedFrom };
      }
      return { type: 'ok', command: current, clampedFrom };
    }
    return { type: 'ok', command: current, clampedFrom };
  }

  private async resolveOpossumPolicy(
    deviceState: OpossumState,
    command: OpossumCommand,
  ): Promise<
    | { type: 'deny'; reason: string }
    | { type: 'ok' | 'require-confirm'; command: OpossumCommand; clampedFrom?: { command: OpossumCommand; reason: string } }
  > {
    let current = command;
    let clampedFrom: { command: OpossumCommand; reason: string } | undefined;

    for (let i = 0; i < POLICY_RESOLVE_MAX_ITERATIONS; i++) {
      const decision = this.options.opossumPolicyEngine.evaluate({
        context: this.options.context,
        command: current,
        deviceState,
      });
      if (decision.type === 'deny') return { type: 'deny', reason: decision.reason };
      if (decision.type === 'clamp') {
        clampedFrom = clampedFrom ?? { command, reason: decision.reason };
        current = decision.command;
        continue;
      }
      if (decision.type === 'require-confirm') {
        return { type: 'require-confirm', command: current, clampedFrom };
      }
      return { type: 'ok', command: current, clampedFrom };
    }
    return { type: 'ok', command: current, clampedFrom };
  }

  private deny(reason: string): string {
    return JSON.stringify({ error: reason, _meta: { kind: 'tool-denied' } });
  }

  private fail(error: unknown): string {
    const reason = error instanceof Error ? error.message : String(error);
    return JSON.stringify({ error: reason, _meta: { kind: 'tool-failed' } });
  }
}
