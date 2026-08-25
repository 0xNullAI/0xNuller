import { isAiDeviceToolName, type AiDeviceToolAdapter } from '@0xnullai/device-runtime';
import type { ToolCall, ToolDefinition } from '@dg-kit/core';
import type { ActionContext, PermissionService } from '@dg-kit/safety';
import type { ToolRegistry } from '@dg-kit/tools';
import type { ToolExecutionResult } from './tool-executor.js';
import type { ToolExecutorLike } from './realtime/voice-tool-bridge.js';

export interface VoiceCompositeToolExecutorOptions {
  legacy: ToolExecutorLike;
  runtime?: AiDeviceToolAdapter;
  permission: PermissionService;
  context: ActionContext;
  onRuntimeToolComplete?: () => void | Promise<void>;
}

/**
 * Routes the generic runtime allowlist to BoundDeviceTools while preserving
 * the legacy executor byte-for-byte for every existing DG tool name.
 */
export class VoiceCompositeToolExecutor implements ToolExecutorLike {
  private readonly options: VoiceCompositeToolExecutorOptions;

  constructor(options: VoiceCompositeToolExecutorOptions) {
    this.options = options;
  }

  async execute(toolCall: ToolCall): Promise<ToolExecutionResult> {
    if (!this.options.runtime || !isAiDeviceToolName(toolCall.name)) {
      return this.options.legacy.execute(toolCall);
    }

    if (toolCall.name === 'device_vibrate') {
      const decision = await this.options.permission.request({
        context: this.options.context,
        toolName: toolCall.name,
        summary: '通用设备振动',
        args: toolCall.args,
      });
      if (decision.type === 'deny') {
        return {
          toolCallId: toolCall.id,
          output: JSON.stringify({
            error: decision.reason ?? '用户拒绝了本次工具调用',
            _meta: { kind: 'tool-denied' },
          }),
        };
      }
    }

    const result = await this.options.runtime.invoke({
      id: toolCall.id,
      name: toolCall.name,
      args: toolCall.args,
    });
    await this.options.onRuntimeToolComplete?.();
    return { toolCallId: toolCall.id, output: JSON.stringify(result) };
  }
}

/** Voice's realtime providers consume ToolDefinition (`parameters`) directly. */
export async function listVoiceToolDefinitions(
  registry: ToolRegistry,
  runtime?: AiDeviceToolAdapter,
): Promise<ToolDefinition[]> {
  const legacy = await registry.listDefinitions();
  if (!runtime) return legacy;
  return [
    ...legacy,
    ...runtime.definitions().map<ToolDefinition>((definition) => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters as Record<string, unknown>,
    })),
  ];
}
