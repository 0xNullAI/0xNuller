import {
  AI_DEVICE_PERMISSION_TOOL_NAMES,
  AI_DEVICE_TOOL_DISPLAY_NAMES,
  isAiDeviceToolName,
  type AiDeviceToolAdapter,
} from '@0xnullai/device-runtime';
import type { ToolCall, ToolDefinition, ToolExecutionPlan } from '@dg-agent/core';
import { ToolRegistry } from '@dg-agent/runtime';

/** Only output-increasing generic tools require Agent's upper permission gate. */
export const AGENT_RUNTIME_PERMISSION_TOOL_NAMES: ReadonlySet<string> =
  AI_DEVICE_PERMISSION_TOOL_NAMES;

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
        displayName: AI_DEVICE_TOOL_DISPLAY_NAMES[definition.name],
        description: definition.description,
        parameters: definition.parameters as Record<string, unknown>,
      })),
    ];
  }

  override getDisplayName(name: string): string | undefined {
    return isAiDeviceToolName(name)
      ? AI_DEVICE_TOOL_DISPLAY_NAMES[name]
      : this.legacy.getDisplayName(name);
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
