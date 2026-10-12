import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  account: 'alice',
  listeners: new Set<() => void>(),
  send: vi.fn((_payload: object) => true),
  close: vi.fn(),
  onMessage: null as ((data: Record<string, unknown>) => void) | null,
  groupAgentTicket: vi.fn(async (_room: string, _characterId: string) => ({
    ticket: 'signed',
    expiresAt: 0,
  })),
}));
vi.mock('@0xnullai/auth', () => ({
  currentAuthUserId: () => state.account,
  subscribeAuthChanges: (fn: () => void) => {
    state.listeners.add(fn);
    return () => state.listeners.delete(fn);
  },
  dmTicket: vi.fn(),
  getChatTicket: vi.fn(),
  getGroupAgentTicket: state.groupAgentTicket,
}));
vi.mock('../lib/room-transport', () => ({
  connectRoom: (opts: { onMessage: (data: Record<string, unknown>) => void }) => {
    state.onMessage = opts.onMessage;
    return { send: state.send, close: state.close };
  },
}));
import { usePeerRoom } from './use-peer-room';
afterEach(() => {
  cleanup();
  state.account = 'alice';
  state.onMessage = null;
  vi.clearAllMocks();
});
it('confirms the sender’s optimistic chat only after the saved server echo', () => {
  const { result } = renderHook(() => usePeerRoom('Alice'));
  act(() => result.current.join('group'));
  act(() =>
    result.current.sendMessage('@助手 你好', undefined, [
      { peerId: 'ai:room', displayName: '助手' },
    ]),
  );
  const message = result.current.messages[0]!;
  expect(message.serverConfirmed).toBeUndefined();
  act(() =>
    state.onMessage!({
      t: 'chat',
      id: message.id,
      _from: result.current.selfId,
      n: 'Alice',
      x: '@助手 你好',
      ts: 123,
      mentions: [{ peerId: 'ai:room', n: '助手' }],
    }),
  );
  expect(result.current.messages).toHaveLength(1);
  expect(result.current.messages[0]).toMatchObject({
    id: message.id,
    serverConfirmed: true,
    fromSelf: true,
  });
});

it('brings an own character in with a ticket for this group, never into a group left meanwhile', async () => {
  const { result } = renderHook(() => usePeerRoom('Alice'));
  act(() => result.current.join('group'));
  const character = { id: 'kitty', name: '小猫', persona: '温柔' };
  await act(async () => {
    expect(await result.current.addMyAgent(character)).toBe(true);
  });
  expect(state.groupAgentTicket).toHaveBeenCalledWith('group', 'kitty');
  expect(state.send).toHaveBeenLastCalledWith({
    t: 'agent-add',
    ticket: 'signed',
    name: '小猫',
    persona: '温柔',
  });
  let release!: () => void;
  state.groupAgentTicket.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ ticket: 'late', expiresAt: 0 });
      }),
  );
  let pending!: Promise<boolean>;
  act(() => {
    pending = result.current.addMyAgent(character);
  });
  act(() => result.current.join('another'));
  await act(async () => {
    release();
    expect(await pending).toBe(false);
  });
  expect(state.send).not.toHaveBeenCalledWith(expect.objectContaining({ ticket: 'late' }));
});
it('lists each group AI as a member labelled with its owner', () => {
  const { result } = renderHook(() => usePeerRoom('Alice'));
  act(() => result.current.join('group'));
  act(() =>
    state.onMessage!({
      t: 'agent',
      agents: [
        { id: 'a1', name: '小猫', persona: '', owner: 'bob', ownerName: 'Bob', dailyCap: 5 },
        { id: 'bad', name: 3 },
      ],
      agent: null,
      host: '',
      billingMode: 'managed',
    }),
  );
  expect(result.current.agents).toEqual([
    { id: 'a1', name: '小猫', persona: '', owner: 'bob', ownerName: 'Bob', dailyCap: 5 },
  ]);
  expect(result.current.members.get('ai:a1')).toMatchObject({
    displayName: '小猫',
    isAi: true,
    aiOwnerName: 'Bob',
  });
});
it('pins the room read admission to the joining account and invalidates A-B-A before React rerender', () => {
  const { result } = renderHook(() => usePeerRoom('Alice'));
  act(() => result.current.join('group'));
  const first = result.current.readAdmission!;
  expect(first).toEqual({ account: 'alice', room: 'group' });
  expect(result.current.isReadAdmissionCurrent(first)).toBe(true);
  act(() => {
    state.account = 'bob';
    for (const fn of state.listeners) fn();
    state.account = 'alice';
    for (const fn of state.listeners) fn();
    expect(result.current.isReadAdmissionCurrent(first)).toBe(false);
  });
  expect(result.current.readAdmission).toBeNull();
  act(() => result.current.join('another'));
  const second = result.current.readAdmission!;
  expect(result.current.isReadAdmissionCurrent(second)).toBe(true);
  act(() => result.current.leave());
  expect(result.current.isReadAdmissionCurrent(second)).toBe(false);
});

it('keeps an unconfirmed message across a history replay, marks it failed and retries with the same id', () => {
  vi.useFakeTimers();
  try {
    const { result } = renderHook(() => usePeerRoom('Alice'));
    act(() => result.current.join('group'));
    act(() => result.current.sendMessage('别丢掉这句话'));
    const id = result.current.messages[0]!.id;
    // A reconnect replays server history that does not contain the unsent message yet.
    act(() => state.onMessage!({ t: 'history', messages: [] }));
    expect(result.current.messages.map((message) => message.text)).toEqual(['别丢掉这句话']);
    act(() => vi.advanceTimersByTime(15_000));
    expect(result.current.messages[0]).toMatchObject({ id, sendFailed: true });

    state.send.mockClear();
    act(() => {
      result.current.retryMessage(id);
    });
    expect(state.send).toHaveBeenCalledWith(
      expect.objectContaining({ t: 'chat', id, x: '别丢掉这句话' }),
    );
    expect(result.current.messages[0]?.sendFailed).toBe(false);
    act(() =>
      state.onMessage!({
        t: 'chat',
        id,
        _from: result.current.selfId,
        n: 'Alice',
        x: '别丢掉这句话',
        ts: 5,
      }),
    );
    act(() => vi.advanceTimersByTime(15_000));
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({ id, serverConfirmed: true });
    expect(result.current.messages[0]?.sendFailed).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

it('discards a failed local message on request', () => {
  vi.useFakeTimers();
  try {
    const { result } = renderHook(() => usePeerRoom('Alice'));
    act(() => result.current.join('group'));
    act(() => result.current.sendMessage('不要了'));
    act(() => vi.advanceTimersByTime(15_000));
    act(() => result.current.discardMessage(result.current.messages[0]!.id));
    expect(result.current.messages).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

it('recognises its own messages in history by account, after a reload changed the peer id', () => {
  const { result } = renderHook(() => usePeerRoom('Alice'));
  act(() => result.current.join('group'));
  act(() =>
    state.onMessage!({
      t: 'history',
      messages: [
        {
          id: 'old-mine',
          _from: 'peer-from-last-visit',
          _account: 'alice',
          n: 'Alice',
          x: '我之前说的',
          ts: 1,
        },
        { id: 'theirs', _from: 'bob-peer', _account: 'bob', n: 'Bob', x: '你好', ts: 2 },
      ],
    }),
  );
  expect(result.current.messages.map((message) => message.fromSelf)).toEqual([true, false]);
});
