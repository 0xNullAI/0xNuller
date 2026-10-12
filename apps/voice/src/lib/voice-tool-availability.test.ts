import { describe, expect, it } from 'vitest';
import { createEmptyDeviceState } from '@dg-kit/core';
import { createEmptyOpossumState } from '@dg-kit/protocol';
import { ToolRegistry } from '@dg-kit/tools';
import { listVoiceToolDefinitions, voiceToolAvailability } from './voice-tool-availability.js';

const disconnectedState = {
  coyotes: [],
  coyote: createEmptyDeviceState(),
  opossum: createEmptyOpossumState(),
};

function registryWith(...names: string[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const name of names) {
    registry.register({
      name,
      definition: { name, description: name, parameters: {} },
      toExecutionPlan: () => ({ type: 'inline', output: name }),
    });
  }
  return registry;
}

describe('Voice tool availability', () => {
  it('only exposes tools for connected DG-Lab devices', async () => {
    const registry = registryWith('shock_start', 'vibrate_start', 'timer');

    const none = voiceToolAvailability(disconnectedState);
    expect((await listVoiceToolDefinitions(registry, none)).map((tool) => tool.name)).toEqual([
      'timer',
    ]);

    const coyote = voiceToolAvailability({
      ...disconnectedState,
      coyotes: [
        {
          targetId: 'coyote/opaque',
          state: { ...disconnectedState.coyote, connected: true },
        },
      ],
      coyote: { ...disconnectedState.coyote, connected: true },
    });
    expect((await listVoiceToolDefinitions(registry, coyote)).map((tool) => tool.name)).toEqual([
      'shock_start',
      'timer',
    ]);

    const opossum = voiceToolAvailability({
      ...disconnectedState,
      opossum: { ...disconnectedState.opossum, connected: true },
    });
    expect((await listVoiceToolDefinitions(registry, opossum)).map((tool) => tool.name)).toEqual([
      'vibrate_start',
      'timer',
    ]);
  });
});
