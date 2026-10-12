// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { createEmptyDeviceState, type SessionSnapshot } from '@dg-agent/core';
import { useVisibleConversationRead } from './use-visible-conversation-read.js';

const state = vi.hoisted(() => ({
  account: 'alice' as string | null,
  listeners: new Set<() => void>(),
  mark: vi.fn(async (_id: string, _sequence: number) => {}),
}));
vi.mock('@0xnullai/auth', () => ({
  currentAuthUserId: () => state.account,
  markPrivateConversationRead: state.mark,
  subscribeAuthChanges: (listener: () => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  },
}));
vi.mock('@dg-agent/storage-browser', () => ({
  getObservedConversationSequence: (
    session: SessionSnapshot & { lastSequence?: number },
    account: string,
  ) => (account === state.account ? (session?.lastSequence ?? null) : null),
}));

function snapshot(lastSequence: number | undefined, id = 's'): SessionSnapshot {
  return {
    id,
    createdAt: 1,
    updatedAt: 1,
    messages: [{ id: 'm', role: 'assistant', content: 'hello', createdAt: 1 }],
    deviceState: createEmptyDeviceState(),
    lastSequence,
  } as SessionSnapshot;
}

beforeEach(() => {
  state.account = 'alice';
  state.listeners.clear();
  state.mark.mockReset();
  state.mark.mockResolvedValue(undefined);
});

it('acknowledges only the loaded sequence in a visible, active conversation', async () => {
  const props = { session: snapshot(2), activeSessionId: 's', visible: false };
  const { rerender } = renderHook((options) => useVisibleConversationRead(options), {
    initialProps: props,
  });
  expect(state.mark).not.toHaveBeenCalled();
  rerender({ ...props, visible: true });
  await waitFor(() => expect(state.mark).toHaveBeenCalledExactlyOnceWith('s', 2));
  rerender({ session: snapshot(3), activeSessionId: 's', visible: true });
  await waitFor(() => expect(state.mark).toHaveBeenLastCalledWith('s', 3));
  expect(state.mark).toHaveBeenCalledTimes(2);
  rerender({ session: snapshot(4), activeSessionId: 'other', visible: true });
  rerender({ session: snapshot(4), activeSessionId: 's', visible: false });
  expect(state.mark).toHaveBeenCalledTimes(2);
});

it('keeps unknown or empty server snapshots unread', () => {
  const { rerender } = renderHook((options) => useVisibleConversationRead(options), {
    initialProps: { session: snapshot(undefined), activeSessionId: 's', visible: true },
  });
  rerender({ session: { ...snapshot(2), messages: [] }, activeSessionId: 's', visible: true });
  expect(state.mark).not.toHaveBeenCalled();
});

it('discards a completion from an account that switched away and back', async () => {
  let resolve!: () => void;
  state.mark.mockImplementationOnce(() => new Promise<void>((done) => (resolve = done)));
  const updated = vi.fn();
  window.addEventListener('0xnullai:conversation-updated', updated);
  const { unmount } = renderHook(() =>
    useVisibleConversationRead({ session: snapshot(2), activeSessionId: 's', visible: true }),
  );
  await waitFor(() => expect(state.mark).toHaveBeenCalledTimes(1));
  act(() => {
    state.account = 'bob';
    for (const listener of state.listeners) listener();
    state.account = 'alice';
    for (const listener of state.listeners) listener();
  });
  await act(async () => resolve());
  await waitFor(() => expect(state.mark).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(updated).toHaveBeenCalledTimes(1));
  unmount();
  window.removeEventListener('0xnullai:conversation-updated', updated);
});
