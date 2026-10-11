import { describe, expect, it } from 'vitest';
import { createEmptyDeviceState, type SessionSnapshot } from '@dg-agent/core';
import {
  appendAcceptedUserMessage,
  hasNewerServerMessages,
  markServerDisplaySnapshot,
  mergeDisplaySnapshot,
} from './use-runtime-session-state';

describe('runtime session rendering', () => {
  it('refreshes only when the server holds messages this screen has not shown', () => {
    expect(hasNewerServerMessages(11, 10)).toBe(true);
    expect(hasNewerServerMessages(10, 10)).toBe(false);
    expect(hasNewerServerMessages(9, 10)).toBe(false);
    expect(hasNewerServerMessages(undefined, 10)).toBe(false);
    expect(hasNewerServerMessages(11, null)).toBe(false);
  });
  it('keeps loaded older pages when a refreshed recent window overlaps them', () => {
    const message = (id: number) => ({
      id: `m${id}`,
      role: 'user' as const,
      content: `text ${id}`,
      createdAt: id,
    });
    const previous: SessionSnapshot = {
      id: 's1',
      createdAt: 1,
      updatedAt: 20,
      deviceState: createEmptyDeviceState(),
      messages: [message(1), message(2), message(3)],
      historyWindow: { nextBefore: 1 },
    };
    const next: SessionSnapshot = {
      ...previous,
      updatedAt: 21,
      messages: [message(3), message(4)],
      historyWindow: { nextBefore: 3 },
    };
    expect(mergeDisplaySnapshot(previous, next).messages.map((item) => item.id)).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
    ]);
    expect(mergeDisplaySnapshot(previous, next).historyWindow?.nextBefore).toBe(1);
    expect(
      mergeDisplaySnapshot({ ...previous, historyWindow: { nextBefore: null } }, next).historyWindow
        ?.nextBefore,
    ).toBeNull();
  });
  it('shows an accepted user message immediately and deduplicates the later snapshot', () => {
    const session: SessionSnapshot = {
      id: 's1',
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      deviceState: createEmptyDeviceState(),
    };
    const message = { id: 'm1', role: 'user' as const, content: '现在显示', createdAt: 2 };
    const next = appendAcceptedUserMessage(session, 's1', message)!;
    expect(next.messages).toEqual([{ ...message, serverConfirmed: false }]);
    expect(appendAcceptedUserMessage(next, 's1', message)).toBe(next);
    const server = markServerDisplaySnapshot({ ...session, messages: [message] });
    expect(mergeDisplaySnapshot(next, server).messages).toEqual([
      { ...message, serverConfirmed: true },
    ]);
    expect(appendAcceptedUserMessage(session, 'other', message)).toBe(session);
  });

  it('does not promote optimistic rows when a server read fails or omits them', () => {
    const session: SessionSnapshot = {
      id: 's1',
      createdAt: 1,
      updatedAt: 1,
      deviceState: createEmptyDeviceState(),
      messages: [],
      historyWindow: { nextBefore: null },
    };
    const optimistic = appendAcceptedUserMessage(session, 's1', {
      id: 'unconfirmed',
      role: 'user',
      content: '稍后同步',
      createdAt: 2,
    })!;
    expect(optimistic.messages[0]).toMatchObject({ serverConfirmed: false });
    const laterRead = markServerDisplaySnapshot({ ...session, messages: [] });
    expect(mergeDisplaySnapshot(optimistic, laterRead).messages[0]).toMatchObject({
      id: 'unconfirmed',
      serverConfirmed: false,
    });
  });
});
