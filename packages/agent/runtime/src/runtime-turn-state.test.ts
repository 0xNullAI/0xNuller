import { describe, expect, it } from 'vitest';
import { createDefaultToolCallConfig } from './tool-call-config.js';
import { consumeTurnQuota, createTurnState } from './runtime-turn-state.js';

describe('consumeTurnQuota stop escape hatch', () => {
  it.each(['shock_stop', 'stop', 'vibrate_stop'])(
    'keeps %s reachable after the ordinary tool budget is exhausted',
    (toolName) => {
      const state = createTurnState();
      const config = { ...createDefaultToolCallConfig(), maxToolCallsPerTurn: 1 };

      expect(consumeTurnQuota('timer', state, config)).toBeNull();
      expect(consumeTurnQuota(toolName, state, config)).toBeNull();
      expect(state.totalToolCalls).toBe(1);
      expect(consumeTurnQuota('timer', state, config)).toContain('工具调用总数已达上限');
    },
  );
});
