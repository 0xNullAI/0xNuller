import { beforeEach, expect, it, vi } from 'vitest';
import type { ActionContext } from '@dg-agent/core';
import { loadPrivateConversationContext } from './private-context.js';
const auth = vi.hoisted(() => ({ loadPrivateCompanionContext: vi.fn() }));
vi.mock('@0xnullai/auth', () => auth);
const input = {
  enabled: true,
  characterId: 'scene',
  context: { sessionId: 's', sourceType: 'web', traceId: 't' } as ActionContext,
  session: {} as { metadata?: Record<string, unknown> },
};
beforeEach(() => {
  auth.loadPrivateCompanionContext.mockReset();
  auth.loadPrivateCompanionContext.mockResolvedValue({
    text: 'shared private context',
    relationshipId: 'r',
  });
  input.session = {};
});
it('delegates the private account context and persists only a newly selected binding', async () => {
  expect(await loadPrivateConversationContext(input)).toBe('shared private context');
  expect(auth.loadPrivateCompanionContext).toHaveBeenCalledWith({
    conversationId: 's',
    characterId: 'scene',
    query: undefined,
    relationshipId: undefined,
  });
  expect(input.session.metadata?.relationshipId).toBe('r');
});
it('never invokes private retrieval for public, bridge, sensor, group, DM or disabled executions', async () => {
  for (const sourceType of ['qq', 'telegram', 'system', 'sensor', 'api', 'cli'] as const)
    expect(
      await loadPrivateConversationContext({ ...input, context: { ...input.context, sourceType } }),
    ).toBe('');
  for (const metadata of [
    { bridgeOrigin: {} },
    { groupId: 'g' },
    { roomId: 'g' },
    { conversationType: 'dm' },
    { conversationType: 'group' },
  ])
    expect(await loadPrivateConversationContext({ ...input, session: { metadata } })).toBe('');
  expect(await loadPrivateConversationContext({ ...input, enabled: false })).toBe('');
  expect(
    await loadPrivateConversationContext({
      ...input,
      context: { ...input.context, sourceChannelId: 'g' },
    }),
  ).toBe('');
  expect(auth.loadPrivateCompanionContext).not.toHaveBeenCalled();
});
