import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ChatMessage } from '../lib/protocol';
import { roomAgentResponders, useRoomAgents } from './use-room-agents';

vi.mock('../lib/ai-config', () => ({ loadAiConfig: () => ({}), isAiConfigured: () => true }));
const llm = vi.hoisted(() => vi.fn());
vi.mock('../lib/llm-client', () => ({ callLlm: llm }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const agents = ['room', 'second', 'third'].map((id) => ({ id, name: id, persona: id }));
const message = (id: string, senderId = 'human'): ChatMessage => ({
  id,
  serverConfirmed: true,
  senderId,
  fromSelf: false,
  senderName: 'User',
  text: 'Hello',
  timestamp: 1,
  mentions: ['ai:room', 'ai:second', 'ai:room', 'ai:third'].map((peerId) => ({
    peerId,
    displayName: peerId,
  })),
});
it('only responds to the configured AI when a human mentions it', () => {
  expect(roomAgentResponders(message('1'), agents)).toEqual(['room']);
  expect(roomAgentResponders(message('2', 'ai:other'), agents)).toEqual([]);
  expect(roomAgentResponders({ ...message('3'), serverConfirmed: false }, agents)).toEqual([]);
});
it('ignores historical mentions and discards the sole pending response after losing host', async () => {
  const pending: Array<(value: { text: string; toolCalls: [] }) => void> = [];
  llm.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
  const sendChatAs = vi.fn();
  const base = {
    roomId: 'group',
    isHost: true,
    agents,
    members: new Map(),
    messages: [message('old')],
    deviceTargets: [],
    requestAgentTurn: vi.fn(async () => 'grant'),
    sendChatAs,
    sendCommandAs: vi.fn(),
  };
  const { rerender } = renderHook((opts) => useRoomAgents(opts), { initialProps: base });
  expect(llm).not.toHaveBeenCalled();
  rerender({ ...base, messages: [...base.messages, message('new')] });
  await waitFor(() => expect(llm).toHaveBeenCalledTimes(1));
  rerender({ ...base, isHost: false, messages: [...base.messages, message('new')] });
  await act(async () => {
    pending[0]!({ text: 'stale', toolCalls: [] });
  });
  expect(llm).toHaveBeenCalledTimes(1);
  expect(sendChatAs).not.toHaveBeenCalled();
});

it('keeps a referenced older message in the selected AI context without triggering other roles', async () => {
  llm.mockResolvedValue({ text: '回答引用', toolCalls: [] });
  const sendChatAs = vi.fn();
  const base = {
    roomId: 'group',
    isHost: true,
    agents: agents.slice(1),
    members: new Map(),
    messages: [] as ChatMessage[],
    deviceTargets: [],
    requestAgentTurn: vi.fn(async () => 'grant'),
    sendChatAs,
    sendCommandAs: vi.fn(),
  };
  const { rerender } = renderHook((opts) => useRoomAgents(opts), { initialProps: base });
  rerender({
    ...base,
    messages: [
      {
        ...message('new'),
        mentions: [{ peerId: 'ai:second', displayName: '同名' }],
        replyTo: {
          id: 'older-than-window',
          senderId: 'ai:second',
          senderName: '同名',
          text: '上次说好的周末计划',
        },
      },
    ],
  });
  await waitFor(() =>
    expect(sendChatAs).toHaveBeenCalledWith('second', '回答引用', 'new', 'grant'),
  );
  expect(llm).toHaveBeenCalledOnce();
  expect(llm.mock.calls[0]![1].at(-1).content).toContain('上次说好的周末计划');
});

it('does not call the model when the server denies or has not confirmed the human trigger', async () => {
  const requestAgentTurn = vi.fn(async () => null);
  const sendChatAs = vi.fn();
  const base = {
    roomId: 'group',
    isHost: true,
    agents,
    members: new Map(),
    messages: [] as ChatMessage[],
    deviceTargets: [],
    requestAgentTurn,
    sendChatAs,
    sendCommandAs: vi.fn(),
  };
  const { rerender } = renderHook((opts) => useRoomAgents(opts), { initialProps: base });
  rerender({ ...base, messages: [{ ...message('optimistic'), serverConfirmed: false }] });
  expect(requestAgentTurn).not.toHaveBeenCalled();
  rerender({ ...base, messages: [message('optimistic')] });
  await waitFor(() => expect(requestAgentTurn).toHaveBeenCalledWith('room', 'optimistic'));
  expect(llm).not.toHaveBeenCalled();
  expect(sendChatAs).not.toHaveBeenCalled();
});

it('does not report a completed AI response when the granted model call fails', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  llm.mockRejectedValue(new Error('provider unavailable'));
  const sendChatAs = vi.fn();
  const base = {
    roomId: 'group',
    isHost: true,
    agents,
    members: new Map(),
    messages: [] as ChatMessage[],
    deviceTargets: [],
    requestAgentTurn: vi.fn(async () => 'grant'),
    sendChatAs,
    sendCommandAs: vi.fn(),
  };
  const { rerender } = renderHook((opts) => useRoomAgents(opts), { initialProps: base });
  rerender({ ...base, messages: [message('failure')] });
  await waitFor(() => expect(warning).toHaveBeenCalledTimes(1));
  expect(sendChatAs).not.toHaveBeenCalled();
  warning.mockRestore();
});
