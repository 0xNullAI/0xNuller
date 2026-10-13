// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { AgentClient } from '@dg-agent/client';
import {
  createEmptyDeviceState,
  type ConversationMessage,
  type RuntimeEvent,
  type SessionSnapshot,
} from '@dg-agent/core';
import { useRuntimeSessionState } from './use-runtime-session-state.js';

vi.mock('@0xnullai/auth', () => ({
  currentAuthUserId: () => 'alice',
  subscribeAuthChanges: () => () => {},
}));
vi.mock('@dg-agent/storage-browser', () => ({
  getObservedConversationSequence: () => null,
}));

function message(id: string, createdAt: number): ConversationMessage {
  return { id, role: 'user', content: id, createdAt };
}

function snapshot(id: string, messages: ConversationMessage[]): SessionSnapshot {
  return {
    id,
    createdAt: 1,
    updatedAt: 1,
    messages,
    deviceState: createEmptyDeviceState(),
    historyWindow: { nextBefore: null },
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

/** A client whose display reads are answered by the test, one at a time. */
function createClient() {
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const reads: Array<{ sessionId: string; reply: Deferred<SessionSnapshot> }> = [];
  const running = new Set<string>();
  const client = {
    listSessions: vi.fn(async () => [] as SessionSnapshot[]),
    getSessionTrace: vi.fn(async () => []),
    getSessionDisplaySnapshot: vi.fn((sessionId: string) => {
      const reply = deferred<SessionSnapshot>();
      reads.push({ sessionId, reply });
      return reply.promise;
    }),
    getSessionMessagesPage: vi.fn(),
    isReplyRunning: (sessionId: string) => running.has(sessionId),
    emergencyStop: vi.fn(async () => {}),
    subscribe: (listener: (event: RuntimeEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as AgentClient & {
    listSessions: ReturnType<typeof vi.fn>;
    getSessionTrace: ReturnType<typeof vi.fn>;
    getSessionDisplaySnapshot: ReturnType<typeof vi.fn>;
  };
  const emit = (event: RuntimeEvent) => {
    for (const listener of listeners) listener(event);
  };
  return { client, reads, running, emit };
}

async function answerAll(
  reads: ReturnType<typeof createClient>['reads'],
  build: (sessionId: string) => SessionSnapshot,
) {
  await act(async () => {
    while (reads.length > 0) {
      const read = reads.shift()!;
      read.reply.resolve(build(read.sessionId));
      await Promise.resolve();
      await Promise.resolve();
    }
  });
}

function mount(client: AgentClient) {
  return renderHook(() => useRuntimeSessionState({ client, enabled: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

it('drops a read that finishes after the user moved to another conversation', async () => {
  const { client, reads } = createClient();
  const { result } = mount(client);
  act(() => result.current.setActiveSessionId('a'));
  await answerAll(reads, (id) => snapshot(id, [message(`${id}-1`, 1)]));

  // A refresh for "a" is in flight when the user opens "b".
  let refresh!: Promise<void>;
  act(() => {
    refresh = result.current.refreshCurrentSession('a');
  });
  const staleRead = reads.shift()!;
  act(() => result.current.setActiveSessionId('b'));
  await answerAll(reads, (id) => snapshot(id, [message(`${id}-1`, 1)]));
  await act(async () => {
    staleRead.reply.resolve(snapshot('a', [message('a-2', 2)]));
    await refresh;
  });

  expect(result.current.session?.id).toBe('b');
  expect(result.current.session?.messages.map((item) => item.id)).toEqual(['b-1']);
  // Once "a" is no longer open, asking to refresh it reads nothing.
  await act(() => result.current.refreshCurrentSession('a'));
  expect(reads).toEqual([]);
});

it('coalesces overlapping reads and never reads the transient trace', async () => {
  const { client, reads, emit } = createClient();
  const { result } = mount(client);
  act(() => result.current.setActiveSessionId('a'));
  await answerAll(reads, (id) => snapshot(id, []));
  client.getSessionDisplaySnapshot.mockClear();
  client.listSessions.mockClear();

  act(() => {
    emit({ type: 'user-message-accepted', sessionId: 'a', message: message('u', 5) } as never);
    emit({ type: 'session-updated', sessionId: 'a' });
    emit({ type: 'session-updated', sessionId: 'a' });
  });
  // One read in flight; the burst behind it runs once more, not three times.
  expect(client.getSessionDisplaySnapshot).toHaveBeenCalledTimes(1);
  await answerAll(reads, (id) => snapshot(id, [message('u', 5)]));
  expect(client.getSessionDisplaySnapshot).toHaveBeenCalledTimes(2);
  // Events of the open conversation do not re-read the navigation list until the turn ends.
  expect(client.listSessions).not.toHaveBeenCalled();
  expect(client.getSessionTrace).not.toHaveBeenCalled();
});

it('keeps a fresh window in server order and merges older rows by time', async () => {
  const { client, reads } = createClient();
  const { result } = mount(client);
  act(() => result.current.setActiveSessionId('a'));
  await answerAll(reads, (id) => snapshot(id, [message('m1', 1), message('m2', 2)]));
  act(() => void result.current.refreshCurrentSession('a'));
  await answerAll(reads, (id) => snapshot(id, [message('m2', 2), message('m3', 3)]));
  expect(result.current.session?.messages.map((item) => item.id)).toEqual(['m1', 'm2', 'm3']);
});

it('shows the stop for a reply already running in the conversation switched to', async () => {
  const { client, reads, running, emit } = createClient();
  const { result } = mount(client);
  act(() => result.current.setActiveSessionId('a'));
  await answerAll(reads, (id) => snapshot(id, []));

  // A timer reply starts in "b" while "a" is open.
  act(() => emit({ type: 'assistant-message-delta', sessionId: 'b', content: '…' } as never));
  expect(result.current.replyBusy).toBe(false);
  act(() => result.current.setActiveSessionId('b'));
  expect(result.current.replyBusy).toBe(true);
  await answerAll(reads, (id) => snapshot(id, []));

  act(() =>
    emit({
      type: 'assistant-message-completed',
      sessionId: 'b',
      message: { ...message('r', 9), role: 'assistant' },
    } as never),
  );
  expect(result.current.replyBusy).toBe(false);

  // A bridge reply already registered by the runtime counts too.
  running.add('a');
  act(() => result.current.setActiveSessionId('a'));
  expect(result.current.replyBusy).toBe(true);
});

it('keeps device action notes after the reply ends, until the conversation is left', async () => {
  const { client, reads, emit } = createClient();
  const { result } = mount(client);
  act(() => result.current.setActiveSessionId('a'));
  await answerAll(reads, (id) => snapshot(id, []));
  act(() =>
    emit({
      type: 'device-command-executed',
      sessionId: 'a',
      command: { type: 'stop' },
      result: { state: createEmptyDeviceState() },
    } as never),
  );
  expect(result.current.liveTraceItems).toHaveLength(1);
  act(() =>
    emit({
      type: 'assistant-message-completed',
      sessionId: 'a',
      message: { ...message('r', 9), role: 'assistant' },
    } as never),
  );
  await answerAll(reads, (id) => snapshot(id, []));
  expect(result.current.liveTraceItems).toHaveLength(1);

  act(() => result.current.setActiveSessionId('b'));
  await waitFor(() => expect(result.current.liveTraceItems).toEqual([]));
});
