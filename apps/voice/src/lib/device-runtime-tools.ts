import {
  AI_DEVICE_TOOL_DISPLAY_NAMES,
  aiDeviceToolRequiresPermission,
  isAiDeviceToolName,
  type AiDeviceToolAdapter,
} from '@0xnullai/device-runtime';
import type { ToolCall, ToolDefinition } from '@dg-kit/core';
import type { ActionContext, PermissionService } from '@dg-kit/safety';
import type { ToolRegistry } from '@dg-kit/tools';
import type { DeviceSessionState } from './device-session.js';
import type { ToolExecutionResult } from './tool-executor.js';
import type { ToolExecutorLike } from './realtime/voice-tool-bridge.js';

export interface VoiceCompositeToolExecutorOptions {
  legacy: ToolExecutorLike;
  runtime?: AiDeviceToolAdapter;
  permission: PermissionService;
  context: ActionContext;
  onRuntimeToolComplete?: () => void | Promise<void>;
}

const COYOTE_TOOL_NAMES = new Set([
  'shock_start',
  'shock_stop',
  'shock_adjust',
  'shock_change_wave',
  'shock_burst',
  'design_wave',
]);
const OPOSSUM_TOOL_NAMES = new Set([
  'vibrate_start',
  'vibrate_stop',
  'vibrate_adjust',
  'vibrate_change_pattern',
  'vibrate_burst',
  'set_indicator_color',
]);

export interface VoiceToolAvailability {
  coyote: boolean;
  opossum: boolean;
  generic: boolean;
}

export function voiceToolAvailability(
  state: DeviceSessionState,
  runtime?: AiDeviceToolAdapter,
  genericEnabled = false,
): VoiceToolAvailability {
  return {
    coyote: state.coyotes.length > 0,
    opossum: state.opossum.connected,
    generic: genericEnabled && hasUsableGenericVibration(runtime),
  };
}

export function hasUsableGenericVibration(runtime?: AiDeviceToolAdapter): boolean {
  return Boolean(
    runtime
      ?.snapshot()
      ?.devices.some((device) =>
        device.capabilities.some(
          (capability) => capability.kind === 'vibrate' && !capability.faulted,
        ),
      ),
  );
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

    if (aiDeviceToolRequiresPermission(toolCall.name)) {
      const decision = await this.options.permission.request({
        context: this.options.context,
        toolName: toolCall.name,
        summary: AI_DEVICE_TOOL_DISPLAY_NAMES[toolCall.name],
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
  availability: VoiceToolAvailability,
  runtime?: AiDeviceToolAdapter,
): Promise<ToolDefinition[]> {
  const legacy = (await registry.listDefinitions())
    .filter((definition) => {
      if (COYOTE_TOOL_NAMES.has(definition.name)) return availability.coyote;
      if (OPOSSUM_TOOL_NAMES.has(definition.name)) return availability.opossum;
      return true;
    })
    .map((definition) =>
      definition.name === 'set_indicator_color' && availability.opossum
        ? narrowIndicatorToolToOpossum(definition)
        : definition,
    );
  if (!runtime || !availability.generic) return legacy;
  return [
    ...legacy,
    ...runtime.definitions().map<ToolDefinition>((definition) => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters as Record<string, unknown>,
    })),
  ];
}

function narrowIndicatorToolToOpossum(definition: ToolDefinition): ToolDefinition {
  const parameters = definition.parameters as { properties?: Record<string, unknown> };
  const deviceKind = parameters.properties?.deviceKind;
  if (!deviceKind || typeof deviceKind !== 'object' || Array.isArray(deviceKind)) return definition;
  return {
    ...definition,
    parameters: {
      ...definition.parameters,
      properties: {
        ...parameters.properties,
        deviceKind: { ...deviceKind, enum: ['opossum'] },
      },
    },
  };
}
