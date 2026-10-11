import { createStore, entries, type UseStore } from 'idb-keyval';
import type { SessionSnapshot } from '@dg-agent/core';
import { toServerSession, type ServerSessionStore } from './server-session-store.js';

function comparable(session: SessionSnapshot): string {
  const { updatedAt: _updatedAt, ...content } = toServerSession(session);
  return JSON.stringify(content);
}

function removeUnchanged(
  database: UseStore,
  key: string,
  original: unknown,
  isCurrent: () => boolean,
): Promise<boolean> {
  return database(
    'readwrite',
    (store) =>
      new Promise<boolean>((resolve, reject) => {
        let removed = false;
        const read = store.get(key);
        read.onsuccess = () => {
          if (isCurrent() && JSON.stringify(read.result) === JSON.stringify(original)) {
            store.delete(key);
            removed = true;
          }
        };
        store.transaction.oncomplete = () => resolve(removed);
        store.transaction.onabort = () => reject(store.transaction.error);
        store.transaction.onerror = () => reject(store.transaction.error);
      }),
  );
}

/** Only explicitly account-partitioned rows are owned. Anonymous/unscoped rows require explicit import. */
export async function migrateOwnedBrowserSessions(
  server: Pick<ServerSessionStore, 'get' | 'save'> & Partial<Pick<ServerSessionStore, 'delete'>>,
  accountId: string,
  isCurrentAccount: () => boolean,
  dbName = 'dg-agent',
): Promise<{ migrated: number; retained: number }> {
  const database = createStore(dbName, 'sessions');
  const prefix = `session:${accountId}:`;
  let migrated = 0;
  let retained = 0;
  for (const [key, value] of await entries<string, SessionSnapshot | number>(database)) {
    if (!key.startsWith(prefix)) continue;
    if (key.startsWith(`${prefix}deleted:`)) {
      if (typeof value !== 'number' || !server.delete) {
        retained++;
        continue;
      }
      if (!isCurrentAccount()) throw new Error('账户已变化，旧记录迁移已停止。');
      try {
        const id = key.slice(`${prefix}deleted:`.length);
        const remote = await server.get(id);
        if (remote && remote.updatedAt > value) {
          retained++;
          continue;
        }
        if (remote) await server.delete(id);
        if (
          (await server.get(id)) === null &&
          isCurrentAccount() &&
          (await removeUnchanged(database, key, value, isCurrentAccount))
        )
          migrated++;
        else retained++;
      } catch {
        retained++;
      }
      continue;
    }
    if (
      !value ||
      typeof value !== 'object' ||
      typeof value.id !== 'string' ||
      key !== `${prefix}${value.id}` ||
      !Array.isArray(value.messages)
    )
      continue;
    if (!isCurrentAccount()) throw new Error('账户已变化，旧记录迁移已停止。');
    try {
      const existing = await server.get(value.id);
      const expected = comparable(value);
      if (!existing) await server.save(value);
      const verified = await server.get(value.id);
      // Do not overwrite remote edits or delete a local record changed by another tab mid-upload.
      if (!verified || comparable(verified) !== expected || !isCurrentAccount()) {
        retained++;
        continue;
      }
      if (await removeUnchanged(database, key, value, isCurrentAccount)) migrated++;
      else retained++;
    } catch {
      retained++;
    }
  }
  return { migrated, retained };
}

export interface UnownedLegacySession {
  key: string;
  session: SessionSnapshot;
}
export async function listUnownedBrowserSessions(
  dbName = 'dg-agent',
): Promise<UnownedLegacySession[]> {
  const database = createStore(dbName, 'sessions');
  return (await entries<string, SessionSnapshot>(database))
    .filter(
      ([key, value]) =>
        value &&
        typeof value.id === 'string' &&
        Array.isArray(value.messages) &&
        (key === `session:${value.id}` || key === `session:anonymous:${value.id}`),
    )
    .map(([key, session]) => ({ key, session }));
}

/** Explicitly chosen unowned rows become new conversations in the confirmed account. */
export async function claimUnownedBrowserSessions(
  server: Pick<ServerSessionStore, 'get' | 'save'> & Partial<Pick<ServerSessionStore, 'delete'>>,
  accountId: string,
  selectedKeys: string[],
  isCurrentAccount: () => boolean,
  dbName = 'dg-agent',
): Promise<{ migrated: number; retained: number }> {
  const database = createStore(dbName, 'sessions');
  const selected = new Set(selectedKeys);
  let migrated = 0;
  let retained = 0;
  for (const { key, session } of await listUnownedBrowserSessions(dbName)) {
    if (!selected.has(key)) continue;
    if (!isCurrentAccount()) throw new Error('账户已变化，请重新确认迁移账户。');
    // Stable retry identity, separate from existing conversations and account-specific.
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`${accountId}\n${key}\n${comparable(session)}`),
    );
    const id = `legacy-${Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')}`;
    const copy = { ...session, id, metadata: { sessionTitle: session.metadata?.sessionTitle } };
    try {
      if (!isCurrentAccount()) throw new Error('账户已变化');
      const existing = await server.get(id);
      if (!existing) await server.save(copy);
      const verified = await server.get(id);
      if (
        verified &&
        comparable(verified) === comparable(copy) &&
        isCurrentAccount() &&
        (await removeUnchanged(database, key, session, isCurrentAccount))
      )
        migrated++;
      else retained++;
    } catch {
      retained++;
    }
  }
  return { migrated, retained };
}
