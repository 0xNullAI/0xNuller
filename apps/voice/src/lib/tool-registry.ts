/**
 * Quota strategy: `createSlidingWindowRateLimitPolicy`, not
 * `createTurnRateLimitPolicy` — a realtime voice session has no "turn"
 * concept the way a chat runtime does, so a rolling time window (the same
 * choice DG-MCP made) is the right model. Caps key on the registry's
 * *current* primary tool names (`shock_adjust`/`shock_burst`/
 * `vibrate_adjust`/`vibrate_burst`), not the pre-1.9.0 aliases — a stale key
 * silently stops limiting instead of erroring.
 */
import { createDefaultToolRegistry, createSlidingWindowRateLimitPolicy } from '@dg-kit/tools';
import type { ToolDefinitionHints } from '@dg-kit/tools';
import type { WaveformLibrary } from '@dg-kit/core';

export function createVoiceToolRegistry(deps: {
  waveformLibrary?: WaveformLibrary;
  toolDefinitionHints?: ToolDefinitionHints;
}) {
  return createDefaultToolRegistry({
    waveformLibrary: deps.waveformLibrary,
    toolDefinitionHints: deps.toolDefinitionHints,
    rateLimitPolicy: createSlidingWindowRateLimitPolicy({
      windowMs: 5000,
      caps: {
        shock_adjust: 2,
        shock_burst: 1,
        design_wave: 1,
        vibrate_adjust: 2,
        vibrate_burst: 1,
      },
    }),
  });
}
