import { describe, expect, it } from 'vitest';
import { createEmptyDeviceState, type SessionSnapshot } from '@dg-agent/core';
import { createDefaultToolCallConfig } from './tool-call-config.js';
import { normalizeAssistantErrorMessage } from './runtime-errors.js';
import { buildConversationItems, consumeTurnQuota, createTurnState } from './runtime-turn-state.js';

describe('buildConversationItems history truthfulness', () => {
  it('keeps saved error replies, including the provider explanation, out of model dialogue', () => {
    const errors = [
      normalizeAssistantErrorMessage(
        new Error('Provider HTTP error 400: {"error":{"message":"key not scoped"}}'),
      ),
      normalizeAssistantErrorMessage(new Error('Provider HTTP error 403: 403')),
    ];
    const session: SessionSnapshot = {
      id: 'errors',
      createdAt: 1,
      updatedAt: 3,
      deviceState: createEmptyDeviceState(),
      messages: [
        { id: 'u1', role: 'user', content: '你好', createdAt: 1 },
        { id: 'e1', role: 'assistant', content: errors[0]!, createdAt: 2 },
        { id: 'u2', role: 'user', content: '在吗', createdAt: 3 },
        { id: 'e2', role: 'assistant', content: errors[1]!, createdAt: 4 },
      ],
    };
    expect(errors[0]).toContain('服务商说明：key not scoped');
    expect(
      buildConversationItems(session, createTurnState(), null, 'full-history').map((item) =>
        item.kind === 'message' ? item.content : '',
      ),
    ).toEqual(['你好', '在吗']);
  });

  it('keeps a camera observation visible in saved history but out of ordinary model dialogue', () => {
    const session: SessionSnapshot = {
      id: 'camera',
      createdAt: 1,
      updatedAt: 3,
      deviceState: createEmptyDeviceState(),
      messages: [
        { id: 'u', role: 'user', content: '你好', createdAt: 1 },
        {
          id: 'c',
          role: 'assistant',
          content: '画面有一张桌子',
          createdAt: 2,
          kind: 'camera_observation',
        },
        { id: 'a', role: 'assistant', content: '你好吗', createdAt: 3 },
      ],
    };
    expect(
      buildConversationItems(session, createTurnState(), null, 'full-history').map((item) =>
        item.kind === 'message' ? item.content : '',
      ),
    ).toEqual(['你好', '你好吗']);
    expect(session.messages).toHaveLength(3);
  });
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
  it('bounds full-history model input by complete user turns while leaving the server session intact', () => {
    const now = Date.now();
    const session: SessionSnapshot = {
      id: 'long-history',
      createdAt: now,
      updatedAt: now,
      deviceState: createEmptyDeviceState(),
      messages: Array.from({ length: 8 }, (_, turn) => [
        {
          id: `u${turn}`,
          role: 'user' as const,
          content: `第 ${turn} 轮 ${'问'.repeat(2800)}`,
          createdAt: now + turn * 2,
        },
        {
          id: `a${turn}`,
          role: 'assistant' as const,
          content: `第 ${turn} 轮 ${'答'.repeat(2800)}`,
          createdAt: now + turn * 2 + 1,
        },
      ]).flat(),
    };
    const items = buildConversationItems(session, createTurnState(), null, 'full-history');
    expect(
      items.map((item) => (item.kind === 'message' ? item.content.slice(0, 5) : 'tool')),
    ).toEqual([
      '第 3 轮',
      '第 3 轮',
      '第 4 轮',
      '第 4 轮',
      '第 5 轮',
      '第 5 轮',
      '第 6 轮',
      '第 6 轮',
      '第 7 轮',
      '第 7 轮',
    ]);
    expect(session.messages).toHaveLength(16);
  });
  it('does not cut a single oversized current user request in the middle', () => {
    const now = Date.now();
    const content = `请停下：${'重要说明'.repeat(9000)}`;
    const session: SessionSnapshot = {
      id: 'huge-current',
      createdAt: now,
      updatedAt: now,
      deviceState: createEmptyDeviceState(),
      messages: [
        { id: 'old', role: 'user', content: '旧话题', createdAt: now },
        { id: 'current', role: 'user', content, createdAt: now + 1 },
      ],
    };
    const items = buildConversationItems(session, createTurnState(), null, 'full-history');
    expect(items).toEqual([
      { kind: 'message', role: 'user', content, reasoningContent: undefined },
    ]);
  });
  it('reserves room for private memory instructions and current turn work', () => {
    const session: SessionSnapshot = {
      id: 'private-long',
      createdAt: 1,
      updatedAt: 5,
      deviceState: createEmptyDeviceState(),
      messages: Array.from({ length: 5 }, (_, index) => ({
        id: `u${index}`,
        role: 'user' as const,
        content: `第${index}轮${'话'.repeat(3000)}`,
        createdAt: index,
      })),
    };
    const input = { kind: 'message' as const, role: 'user' as const, content: '继续聊昨天的事' };
    const items = buildConversationItems(session, createTurnState(), input, 'full-history', 24_000);
    expect(items.map((item) => (item.kind === 'message' ? item.content.slice(0, 2) : ''))).toEqual([
      '第3',
      '第4',
      '继续',
    ]);
    expect(session.messages).toHaveLength(5);
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
