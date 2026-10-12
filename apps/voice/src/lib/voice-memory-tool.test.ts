import { beforeEach, expect, it, vi } from 'vitest';
import type { PrivateConversationChannel } from '@0xnullai/auth';
import { VOICE_MEMORY_SEARCH, withVoiceMemorySearch } from './voice-memory-tool.js';

const auth = vi.hoisted(() => ({ getMemoryContext: vi.fn() }));
vi.mock('@0xnullai/auth', () => ({ getMemoryContext: auth.getMemoryContext }));

function channel(relationshipId = 'r') {
  const assertCurrent = vi.fn();
  return {
    selection: { conversationId: 'conversation', relationshipId },
    assertCurrent,
  } as unknown as PrivateConversationChannel;
}

const device = { execute: vi.fn(async () => ({ toolCallId: 'device', output: '{}' })) };

beforeEach(() => {
  vi.clearAllMocks();
  auth.getMemoryContext.mockResolvedValue({
    relationshipId: 'r',
    shortTerm: [],
    mediumTerm: [
      {
        id: 'm',
        tier: 'medium',
        title: '约定',
        content: '周日一起读书',
        sourceRefs: [],
      },
    ],
    longTerm: [],
    relationshipHistory: [],
    historyRecap: [{ id: 'old-user', content: '上次说到读书', truncated: false }],
  });
});

it('offers a read-only voice memory tool that returns sourced private context', async () => {
  expect(VOICE_MEMORY_SEARCH.name).toBe('memory_search');
  const executor = withVoiceMemorySearch(device, channel());
  const result = await executor.execute({
    id: 'call',
    name: 'memory_search',
    args: { query: '读书' },
  });
  expect(auth.getMemoryContext).toHaveBeenCalledWith('conversation', '读书');
  expect(device.execute).not.toHaveBeenCalled();
  expect(JSON.parse(result.output)).toMatchObject({
    memories: [{ content: '周日一起读书' }],
    historyRecap: [{ sourceMessageId: 'old-user' }],
  });
});

it('rejects missing binding, mismatched relationships and malformed lookup arguments', async () => {
  await expect(
    withVoiceMemorySearch(device, channel('')).execute({
      id: 'call',
      name: 'memory_search',
      args: { query: '读书' },
    }),
  ).rejects.toThrow('尚未绑定');
  await expect(
    withVoiceMemorySearch(device, channel()).execute({
      id: 'call',
      name: 'memory_search',
      args: { query: '读书', permission: 'allow' },
    }),
  ).rejects.toThrow('条件无效');
  auth.getMemoryContext.mockResolvedValueOnce({ relationshipId: 'other' });
  await expect(
    withVoiceMemorySearch(device, channel()).execute({
      id: 'call',
      name: 'memory_search',
      args: { query: '读书' },
    }),
  ).rejects.toThrow('关系已变化');
});

it('does not route device tools through memory retrieval', async () => {
  await withVoiceMemorySearch(device, channel()).execute({
    id: 'device',
    name: 'shock_stop',
    args: {},
  });
  expect(device.execute).toHaveBeenCalledOnce();
  expect(auth.getMemoryContext).not.toHaveBeenCalled();
});
