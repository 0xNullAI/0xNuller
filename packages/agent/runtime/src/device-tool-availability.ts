import type { DeviceKind, ToolDefinition } from '@dg-agent/core';

const LED_CAPABLE_DEVICE_KINDS = ['paw-prints', 'civet-edging', 'opossum'] as const;

/**
 * Resolves the device kind targeted by an LLM tool call. Legacy Coyote aliases
 * remain recognized because the registry can still execute them.
 */
export function resolveRequiredDeviceKind(
  toolName: string,
  args: Record<string, unknown> | undefined,
): DeviceKind | null {
  switch (toolName) {
    case 'shock_start':
    case 'shock_stop':
    case 'shock_adjust':
    case 'shock_change_wave':
    case 'shock_burst':
    case 'start':
    case 'stop':
    case 'adjust_strength':
    case 'change_wave':
    case 'burst':
      return 'coyote';
    case 'vibrate_start':
    case 'vibrate_stop':
    case 'vibrate_adjust':
    case 'vibrate_change_pattern':
    case 'vibrate_burst':
      return 'opossum';
    case 'set_indicator_color': {
      const kind = args?.deviceKind;
      return kind === 'paw-prints' || kind === 'civet-edging' || kind === 'opossum' ? kind : null;
    }
    default:
      return null;
  }
}

/**
 * Filters the definitions sent to the model to connected device kinds. The
 * execution boundary still checks connectivity independently before dispatch.
 */
export function filterToolDefinitionsByConnectedDevices(
  definitions: ToolDefinition[],
  connectedKinds: ReadonlySet<DeviceKind>,
): ToolDefinition[] {
  const result: ToolDefinition[] = [];
  for (const definition of definitions) {
    if (definition.name === 'set_indicator_color') {
      const allowedKinds = LED_CAPABLE_DEVICE_KINDS.filter((kind) => connectedKinds.has(kind));
      if (allowedKinds.length === 0) continue;
      result.push(narrowIndicatorColorDeviceKindEnum(definition, allowedKinds));
      continue;
    }

    const requiredKind = resolveRequiredDeviceKind(definition.name, undefined);
    if (requiredKind && !connectedKinds.has(requiredKind)) continue;
    result.push(definition);
  }
  return result;
}

function narrowIndicatorColorDeviceKindEnum(
  definition: ToolDefinition,
  allowedKinds: readonly DeviceKind[],
): ToolDefinition {
  const parameters = definition.parameters as {
    properties?: Record<string, unknown>;
  };
  const deviceKindProperty = parameters.properties?.deviceKind as
    Record<string, unknown> | undefined;
  if (!deviceKindProperty) return definition;

  return {
    ...definition,
    parameters: {
      ...definition.parameters,
      properties: {
        ...parameters.properties,
        deviceKind: { ...deviceKindProperty, enum: allowedKinds },
      },
    },
  };
}
