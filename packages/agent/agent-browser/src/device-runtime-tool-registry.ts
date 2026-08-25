import {
  isAiDeviceToolName,
  type AiDeviceToolAdapter,
  type AiDeviceToolName,
} from '@0xnullai/device-runtime';
import type { ToolCall, ToolDefinition, ToolExecutionPlan } from '@dg-agent/core';
import { ToolRegistry } from '@dg-agent/runtime';

/** Only output-increasing generic tools require Agent's upper permission gate. */
export const AGENT_RUNTIME_PERMISSION_TOOL_NAMES: ReadonlySet<string> = new Set(['device_vibrate']);

const DISPLAY_NAMES: Record<AiDeviceToolName, string> = {
  device_snapshot: '读取通用设备状态',
  device_vibrate: '通用设备振动',
  device_stop: '停止通用设备功能',
  device_emergency_stop: '紧急停止通用设备',
};

/**
 * One ToolRegistry keeps all legacy DG tools and adds the small generic
 * runtime allowlist. Runtime results use the existing inline-plan path, so
 * RuntimeToolExecutor still owns quotas, traces, aborts, and upper permission.
 */
export class DeviceRuntimeToolRegistry extends ToolRegistry {
  constructor(
    private readonly legacy: ToolRegistry,
    private readonly runtime: AiDeviceToolAdapter,
  ) {
    super();
  }

  override async resolve(toolCall: ToolCall): Promise<ToolExecutionPlan> {
    if (!isAiDeviceToolName(toolCall.name)) return this.legacy.resolve(toolCall);
    const output = await this.runtime.invoke({
      id: toolCall.id,
      name: toolCall.name,
      args: toolCall.args,
    });
    return { type: 'inline', output: JSON.stringify(output) };
  }

  override async listDefinitions(): Promise<ToolDefinition[]> {
    const legacy = await this.legacy.listDefinitions();
    return [
      ...legacy,
      ...this.runtime.definitions().map<ToolDefinition>((definition) => ({
        name: definition.name,
        displayName: DISPLAY_NAMES[definition.name],
        description: definition.description,
        parameters: definition.parameters as Record<string, unknown>,
      })),
    ];
  }

  override getDisplayName(name: string): string | undefined {
    return isAiDeviceToolName(name) ? DISPLAY_NAMES[name] : this.legacy.getDisplayName(name);
  }

  override summarizeCommand(
    name: string,
    command: Parameters<ToolRegistry['summarizeCommand']>[1],
  ) {
    return this.legacy.summarizeCommand(name, command);
  }

  override resetTurn(): void {
    this.legacy.resetTurn();
  }
}
