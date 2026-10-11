import type { ToolDefinition } from '@dg-kit/core';
import type { ToolRegistry } from '@dg-kit/tools';
import type { DeviceSessionState } from './device-session.js';

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
}

/** Only connected DG-Lab devices contribute tools; a disconnect removes them from the session. */
export function voiceToolAvailability(state: DeviceSessionState): VoiceToolAvailability {
  return {
    coyote: state.coyotes.length > 0,
    opossum: state.opossum.connected,
  };
}

/** Voice's realtime providers consume ToolDefinition (`parameters`) directly. */
export async function listVoiceToolDefinitions(
  registry: ToolRegistry,
  availability: VoiceToolAvailability,
): Promise<ToolDefinition[]> {
  return (await registry.listDefinitions())
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
