import 'fake-indexeddb/auto';
import { createStore, get, set } from 'idb-keyval';
import { describe, expect, it, vi } from 'vitest';
import { createEmptyDeviceState, type SessionSnapshot } from '@dg-agent/core';
import {
  claimUnownedBrowserSessions,
  listUnownedBrowserSessions,
  migrateOwnedBrowserSessions,
} from './server-session-migration.js';

const session = (): SessionSnapshot => ({
  id: 's',
  createdAt: 1,
  updatedAt: 1,
  messages: [{ id: 'm', role: 'user', content: 'history', createdAt: 1 }],
  deviceState: createEmptyDeviceState(),
});
describe('verified account-owned history migration', () => {
  it('uploads and reads back before deleting only the matching owned record', async () => {
    const dbName = crypto.randomUUID();
    const db = createStore(dbName, 'sessions');
    const row = session();
    await set('session:alice:s', row, db);
    await set('session:anonymous:s', row, db);
    await set('session:s', row, db);
    await set('session:bob:s', row, db);
    let remote: SessionSnapshot | null = null;
    const result = await migrateOwnedBrowserSessions(
      {
        get: async () => remote,
        save: async (s) => {
          expect(await get('session:alice:s', db)).toEqual(row);
          remote = { ...s, updatedAt: 99 };
        },
      },
      'alice',
      () => true,
      dbName,
    );
    expect(result).toEqual({ migrated: 1, retained: 0 });
    expect(await get('session:alice:s', db)).toBeUndefined();
    for (const key of ['session:anonymous:s', 'session:s', 'session:bob:s'])
      expect(await get(key, db)).toEqual(row);
  });
  it('retains originals after failed upload, failed readback or remote conflicts', async () => {
    for (const mode of ['upload', 'readback', 'conflict']) {
      const dbName = crypto.randomUUID();
      const db = createStore(dbName, 'sessions');
      const row = session();
      await set('session:alice:s', row, db);
      const getRemote = vi
        .fn()
        .mockResolvedValue(mode === 'conflict' ? { ...row, messages: [] } : null);
      const result = await migrateOwnedBrowserSessions(
        {
          get: getRemote,
          save: async () => {
            if (mode === 'upload') throw new Error('offline');
          },
        },
        'alice',
        () => true,
        dbName,
      );
      expect(result).toEqual({ migrated: 0, retained: 1 });
      expect(await get('session:alice:s', db)).toEqual(row);
    }
  });
  it('does not delete when ownership changes during verification', async () => {
    const dbName = crypto.randomUUID();
    const db = createStore(dbName, 'sessions');
    const row = session();
    await set('session:alice:s', row, db);
    let active = true;
    let reads = 0;
    await migrateOwnedBrowserSessions(
      {
        get: async () => {
          if (++reads === 1) return null;
          active = false;
          return row;
        },
        save: async () => {},
      },
      'alice',
      () => active,
      dbName,
    );
    expect(await get('session:alice:s', db)).toEqual(row);
  });
});

it('requires explicit unowned selection, uses stable new IDs and never reads another account partition', async () => {
  const dbName = crypto.randomUUID();
  const db = createStore(dbName, 'sessions');
  const row = session();
  await set('session:anonymous:s', row, db);
  await set('session:bob:s', row, db);
  const unowned = await listUnownedBrowserSessions(dbName);
  expect(unowned.map((item) => item.key)).toEqual(['session:anonymous:s']);
  const remote = new Map<string, SessionSnapshot>();
  const api = {
    get: async (id: string) => remote.get(id) ?? null,
    save: async (s: SessionSnapshot) => {
      remote.set(s.id, { ...s, updatedAt: 99 });
    },
  };
  expect(await claimUnownedBrowserSessions(api, 'alice', [], () => true, dbName)).toEqual({
    migrated: 0,
    retained: 0,
  });
  expect(
    await claimUnownedBrowserSessions(
      api,
      'alice',
      ['session:anonymous:s', 'session:bob:s'],
      () => true,
      dbName,
    ),
  ).toEqual({ migrated: 1, retained: 0 });
  expect([...remote.keys()][0]).toMatch(/^legacy-/);
  expect(await get('session:bob:s', db)).toEqual(row);
  expect(await get('session:anonymous:s', db)).toBeUndefined();
});

it('replays an owned deletion only when it does not erase a newer remote edit', async () => {
  const dbName = crypto.randomUUID();
  const db = createStore(dbName, 'sessions');
  await set('session:alice:deleted:s', 10, db);
  let remote: SessionSnapshot | null = { ...session(), updatedAt: 20 };
  const remove = vi.fn(async () => {
    remote = null;
  });
  const api = { get: async () => remote, save: async () => {}, delete: remove };
  expect(await migrateOwnedBrowserSessions(api, 'alice', () => true, dbName)).toEqual({
    migrated: 0,
    retained: 1,
  });
  expect(remove).not.toHaveBeenCalled();
  remote = session();
  expect(await migrateOwnedBrowserSessions(api, 'alice', () => true, dbName)).toEqual({
    migrated: 1,
    retained: 0,
  });
  expect(await get('session:alice:deleted:s', db)).toBeUndefined();
});
