import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyDeviceState, type SessionSnapshot } from '@dg-agent/core';
import { BrowserSessionStore, type AgentSessionRemote } from './browser-session-store.js';

function snapshot(id: string, updatedAt: number, content = id): SessionSnapshot {
  return {
    id,
    createdAt: updatedAt,
    updatedAt,
    deviceState: createEmptyDeviceState(),
    messages: [{ id: `${id}-message`, role: 'user', content, createdAt: updatedAt }],
  };
}

function options(remote: AgentSessionRemote, accountId = 'account-a') {
  return {
    dbName: `agent-sync-${crypto.randomUUID()}`,
    remote,
    accountId: () => accountId,
    subscribeAccount: () => () => undefined,
    syncDebounceMs: 1,
  };
}

afterEach(() => vi.useRealTimers());

describe('BrowserSessionStore account sync', () => {
  it('keeps local history usable when the account service is offline', async () => {
    const remote: AgentSessionRemote = {
      list: vi.fn().mockRejectedValue(new Error('offline')),
      save: vi.fn().mockRejectedValue(new Error('offline')),
    };
    const store = new BrowserSessionStore(options(remote));
    await store.save(snapshot('local', 10));

    await expect(store.list()).resolves.toEqual([expect.objectContaining({ id: 'local' })]);
  });

  it('pulls remote sessions and keeps the newer local edit', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const remote: AgentSessionRemote = {
      list: vi.fn().mockResolvedValue({
        sessions: [
          {
            id: 'shared',
            session: snapshot('shared', 20, 'remote-old'),
            clientUpdatedAt: 20,
            updatedAt: 30,
            deleted: false,
          },
          {
            id: 'remote-only',
            session: snapshot('remote-only', 40),
            clientUpdatedAt: 40,
            updatedAt: 40,
            deleted: false,
          },
        ],
        cursor: 40,
        hasMore: false,
      }),
      save,
    };
    const store = new BrowserSessionStore(options(remote));
    await store.save(snapshot('shared', 50, 'local-new'));

    const sessions = await store.list();
    expect(sessions.map((session) => session.id)).toEqual(['shared', 'remote-only']);
    expect(sessions[0]?.messages[0]?.content).toBe('local-new');
    expect(save).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'shared', clientUpdatedAt: 50 })]),
    );
  });

  it('uploads a durable tombstone when a session is deleted', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const remote: AgentSessionRemote = {
      list: vi.fn().mockResolvedValue({ sessions: [], cursor: 0, hasMore: false }),
      save,
    };
    const store = new BrowserSessionStore(options(remote));
    await store.save(snapshot('gone', 10));
    await store.delete('gone');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(save).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: 'gone', deleted: true, clientUpdatedAt: expect.any(Number) }),
    ]);
    await expect(store.list()).resolves.toEqual([]);
  });

  it('partitions local working copies by account', async () => {
    let account = 'account-a';
    let notify = () => undefined;
    const remote: AgentSessionRemote = {
      list: vi.fn().mockResolvedValue({ sessions: [], cursor: 0, hasMore: false }),
      save: vi.fn().mockResolvedValue(undefined),
    };
    const store = new BrowserSessionStore({
      ...options(remote),
      accountId: () => account,
      subscribeAccount: (listener) => {
        notify = listener;
        return () => undefined;
      },
    });
    await store.save(snapshot('only-a', 10));
    account = 'account-b';
    notify();

    await expect(store.list()).resolves.toEqual([]);
  });
});
