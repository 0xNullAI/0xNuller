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
import type { OpossumPolicyEngine, PolicyEngine } from '@dg-kit/safety';
import type { DeviceCommandQueue, OpossumCommandQueue } from '@dg-kit/safety';
import type { DeviceSession } from './device-session.js';
import type { ActionContext, PermissionService } from '@dg-kit/safety';

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

/**
 * DG-Voice only wires up Coyote + Opossum (see `device-session.ts` for why
 * the sensor kinds aren't supported) — `set_indicator_color` targeting
 * `paw-prints`/`civet-edging` falls through to `null` here, which
 * `executeSetIndicatorColor` denies with a clear reason rather than
 * crashing on a client that doesn't exist.
 */
function resolveRequiredDeviceKind(
  toolName: string,
  args: Record<string, unknown>,
): DeviceKind | null {
  if (SHOCK_TOOL_NAMES.has(toolName)) return 'coyote';
  if (VIBRATE_TOOL_NAMES.has(toolName)) return 'opossum';
  if (toolName === 'set_indicator_color') {
    return args.deviceKind === 'opossum' ? 'opossum' : null;
  }
  return null;
}

/**
 * Human-readable one-liners for the permission modal. The dialog is the
 * user's last checkpoint before a device actually moves, so it describes
 * the POST-policy command (what will really run, after any clamp), not the
 * model's original request.
 */
function describeDeviceCommand(command: DeviceCommand): string {
  switch (command.type) {
    case 'start':
      return `启动郊狼 ${command.channel} 通道，强度 ${command.strength}，波形「${command.waveform.name}」`;
    case 'stop':
      return command.channel ? `停止郊狼 ${command.channel} 通道` : '停止郊狼全部通道';
    case 'adjustStrength':
      return `${command.delta >= 0 ? '调高' : '调低'}郊狼 ${command.channel} 通道强度 ${Math.abs(command.delta)}`;
    case 'changeWave':
      return `切换郊狼 ${command.channel} 通道波形为「${command.waveform.name}」`;
    case 'burst':
      return `郊狼 ${command.channel} 通道短促加强到 ${command.strength}，持续 ${command.durationMs}ms`;
    case 'emergencyStop':
      return '紧急停止郊狼';
  }
}

function describeOpossumCommand(command: OpossumCommand): string {
  switch (command.type) {
    case 'vibrateStart':
      return `启动负鼠 ${command.channel} 通道振动，强度 ${command.intensity}`;
    case 'vibrateStop':
      return command.channel ? `停止负鼠 ${command.channel} 通道振动` : '停止负鼠全部振动';
    case 'vibrateAdjust':
      return `${command.delta >= 0 ? '调高' : '调低'}负鼠 ${command.channel} 通道强度 ${Math.abs(command.delta)}`;
    case 'vibrateSetPattern':
      return `切换负鼠 ${command.channel} 通道振动节奏`;
    case 'vibrateBurst':
      return `负鼠 ${command.channel} 通道短促加强到 ${command.intensity}，持续 ${command.durationMs}ms`;
  }
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
      case 'civet-edging':
        return false;
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
        summary: describeDeviceCommand(resolved.command),
        args: resolved.command as unknown as Record<string, unknown>,
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
        summary: describeOpossumCommand(resolved.command),
        args: resolved.command as unknown as Record<string, unknown>,
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
    if (deviceKind !== 'opossum') {
      // paw-prints/civet-edging aren't wired up in DG-Voice at all (see
      // device-session.ts) — deny with a clear reason instead of touching a
      // client that doesn't exist.
      return this.deny(`DG-Voice 不支持控制${DEVICE_KIND_DISPLAY_NAME[deviceKind]}`);
    }
    const client = this.options.session.opossum;
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
    | {
        type: 'ok' | 'require-confirm';
        command: OpossumCommand;
        clampedFrom?: { command: OpossumCommand; reason: string };
      }
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
