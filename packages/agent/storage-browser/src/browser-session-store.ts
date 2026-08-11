import { createStore, del, entries, get, set, type UseStore } from 'idb-keyval';
import { currentAuthUserId, subscribeAuthChanges } from '@0xnullai/auth';
import { pullAgentSessions, pushAgentSessions } from '@0xnullai/sync';
import type { SessionSnapshot, SessionStore } from '@dg-agent/core';
import { SESSION_KEY_PREFIX } from './browser-settings-constants.js';

const ANONYMOUS_SCOPE = 'anonymous';
const TOMBSTONE_PREFIX = 'deleted:';
const SYNC_DEBOUNCE_MS = 800;

export interface AgentSessionRemote {
  list(since?: number): Promise<{
    sessions: Array<{
      id: string;
      session: unknown | null;
      clientUpdatedAt: number;
      updatedAt: number;
      deleted: boolean;
    }>;
    cursor: number;
    hasMore: boolean;
  }>;
  save(sessions: Parameters<typeof pushAgentSessions>[0]): Promise<boolean | void>;
}

export interface BrowserSessionStoreOptions {
  dbName?: string;
  storeName?: string;
  remote?: AgentSessionRemote;
  accountId?: () => string | null;
  subscribeAccount?: (listener: () => void) => () => void;
  syncDebounceMs?: number;
}

/**
 * Local-first Agent history. IndexedDB is always the working copy; when an
 * account is present, rows are merged by the session's client `updatedAt` and
 * writes are uploaded in the background. A network/auth failure never makes a
 * local conversation unavailable.
 */
export class BrowserSessionStore implements SessionStore {
  private readonly store: UseStore;
  private readonly remote: AgentSessionRemote;
  private readonly accountId: () => string | null;
  private readonly debounceMs: number;
  private syncPromise: Promise<void> | null = null;
  private uploadTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Map<
    string,
    { session: SessionSnapshot | null; clientUpdatedAt: number }
  >();
  private legacyMigrated = false;

  constructor(options: BrowserSessionStoreOptions = {}) {
    this.store = createStore(options.dbName ?? 'dg-agent', options.storeName ?? 'sessions');
    this.remote = options.remote ?? {
      list: async (since) => {
        const page = await pullAgentSessions(since);
        if (!page) throw new Error('Agent session sync unavailable');
        return page;
      },
      save: pushAgentSessions,
    };
    this.accountId = options.accountId ?? currentAuthUserId;
    this.debounceMs = options.syncDebounceMs ?? SYNC_DEBOUNCE_MS;
    const subscribe = options.subscribeAccount ?? ((listener) => subscribeAuthChanges(listener));
    subscribe(() => {
      this.syncPromise = null;
      this.pending.clear();
      if (this.uploadTimer) clearTimeout(this.uploadTimer);
      this.uploadTimer = null;
    });
  }

  async get(sessionId: string): Promise<SessionSnapshot | null> {
    await this.ensureSynced();
    return (await get<SessionSnapshot>(this.key(sessionId), this.store)) ?? null;
  }

  async save(session: SessionSnapshot): Promise<void> {
    await set(this.key(session.id), session, this.store);
    await del(this.tombstoneKey(session.id), this.store);
    if (this.accountId()) {
      this.pending.set(session.id, { session, clientUpdatedAt: session.updatedAt });
      this.scheduleUpload();
    }
  }

  async list(): Promise<SessionSnapshot[]> {
    await this.ensureSynced();
    const prefix = this.scopePrefix();
    const allEntries = await entries<string, SessionSnapshot>(this.store);
    return allEntries
      .filter(([key]) => key.startsWith(prefix) && !key.startsWith(`${prefix}${TOMBSTONE_PREFIX}`))
      .map(([, session]) => session)
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async delete(sessionId: string): Promise<void> {
    const deletedAt = Date.now();
    await del(this.key(sessionId), this.store);
    await set(this.tombstoneKey(sessionId), deletedAt, this.store);
    if (this.accountId()) {
      this.pending.set(sessionId, { session: null, clientUpdatedAt: deletedAt });
      this.scheduleUpload();
    }
  }

  private ensureSynced(): Promise<void> {
    this.syncPromise ??= this.sync().catch(() => undefined);
    return this.syncPromise;
  }

  private async sync(): Promise<void> {
    await this.migrateLegacySessions();
    if (!this.accountId()) return;
    let cursor = 0;
    let hasMore = true;
    while (hasMore) {
      const page = await this.remote.list(cursor);
      for (const remote of page.sessions) {
        const local = await get<SessionSnapshot>(this.key(remote.id), this.store);
        const deletedAt = (await get<number>(this.tombstoneKey(remote.id), this.store)) ?? 0;
        const localUpdatedAt = Math.max(local?.updatedAt ?? 0, deletedAt);
        if (remote.clientUpdatedAt >= localUpdatedAt) {
          if (remote.deleted) {
            await del(this.key(remote.id), this.store);
            await set(this.tombstoneKey(remote.id), remote.clientUpdatedAt, this.store);
          } else if (remote.session) {
            await set(this.key(remote.id), remote.session as SessionSnapshot, this.store);
            await del(this.tombstoneKey(remote.id), this.store);
          }
        } else {
          this.pending.set(remote.id, { session: local ?? null, clientUpdatedAt: localUpdatedAt });
        }
      }
      cursor = page.cursor;
      hasMore = page.hasMore;
    }

    // Upload local-only rows after the pull, including work made offline.
    const prefix = this.scopePrefix();
    const allEntries = await entries<string, SessionSnapshot | number>(this.store);
    for (const [key, value] of allEntries) {
      if (!key.startsWith(prefix)) continue;
      const suffix = key.slice(prefix.length);
      if (suffix.startsWith(TOMBSTONE_PREFIX)) {
        this.pending.set(suffix.slice(TOMBSTONE_PREFIX.length), {
          session: null,
          clientUpdatedAt: Number(value) || 0,
        });
      } else if (value && typeof value === 'object') {
        const session = value as SessionSnapshot;
        this.pending.set(suffix, { session, clientUpdatedAt: session.updatedAt });
      }
    }
    await this.flushUpload();
  }

  private scheduleUpload(): void {
    if (this.uploadTimer) clearTimeout(this.uploadTimer);
    this.uploadTimer = setTimeout(() => {
      this.uploadTimer = null;
      void this.flushUpload().catch(() => undefined);
    }, this.debounceMs);
  }

  private async flushUpload(): Promise<void> {
    if (!this.accountId() || this.pending.size === 0) return;
    const batch = [...this.pending.entries()].map(([id, operation]) => ({
      id,
      session: operation.session ?? undefined,
      clientUpdatedAt: operation.clientUpdatedAt,
      deleted: operation.session === null,
    }));
    const saved = await this.remote.save(batch);
    if (saved === false) throw new Error('Agent session sync unavailable');
    for (const [id, operation] of this.pending) {
      if (
        batch.some(
          (item) =>
            item.id === id &&
            item.clientUpdatedAt === operation.clientUpdatedAt &&
            item.session === (operation.session ?? undefined),
        )
      ) {
        this.pending.delete(id);
      }
    }
  }

  private async migrateLegacySessions(): Promise<void> {
    if (this.legacyMigrated) return;
    this.legacyMigrated = true;
    const allEntries = await entries<string, SessionSnapshot>(this.store);
    for (const [key, session] of allEntries) {
      if (
        key === `${SESSION_KEY_PREFIX}${session?.id}` &&
        session &&
        typeof session === 'object' &&
        typeof session.id === 'string'
      ) {
        await set(this.key(session.id), session, this.store);
        await del(key, this.store);
      }
    }
  }

  private scopePrefix(): string {
    return `${SESSION_KEY_PREFIX}${this.accountId() ?? ANONYMOUS_SCOPE}:`;
  }

  private key(sessionId: string): string {
    return `${this.scopePrefix()}${sessionId}`;
  }

  private tombstoneKey(sessionId: string): string {
    return `${this.scopePrefix()}${TOMBSTONE_PREFIX}${sessionId}`;
  }
}
