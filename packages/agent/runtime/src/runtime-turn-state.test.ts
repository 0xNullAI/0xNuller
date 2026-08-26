import { describe, expect, it } from 'vitest';
import { createEmptyDeviceState, type SessionSnapshot } from '@dg-agent/core';
import { createDefaultToolCallConfig } from './tool-call-config.js';
import { buildConversationItems, consumeTurnQuota, createTurnState } from './runtime-turn-state.js';

describe('buildConversationItems history truthfulness', () => {
  it('omits tool narration whose result is not persisted', () => {
    const now = Date.now();
    const session: SessionSnapshot = {
      id: 'history',
      createdAt: now,
      updatedAt: now,
      deviceState: createEmptyDeviceState(),
      messages: [
        { id: 'u1', role: 'user', content: '调高一点', createdAt: now },
        {
          id: 'a1',
          role: 'assistant',
          content: '已经帮你调高了。',
          createdAt: now + 1,
          toolCalls: [{ id: 'call-1', name: 'shock_adjust', args: { channel: 'A', delta: 2 } }],
        },
        { id: 'a2', role: 'assistant', content: '现在感觉怎么样？', createdAt: now + 2 },
      ],
    };

    expect(
      buildConversationItems(session, createTurnState(), null, 'full-history').map((item) =>
        item.kind === 'message' ? `${item.role}:${item.content}` : item.kind,
      ),
    ).toEqual(['user:调高一点', 'assistant:现在感觉怎么样？']);
  });
});

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
