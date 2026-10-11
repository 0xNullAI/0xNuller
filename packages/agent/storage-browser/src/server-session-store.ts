import { migrateOwnedBrowserSessions } from './server-session-migration.js';
import { authRequestHeaders, currentAuthUserId, subscribeAuthChanges } from '@0xnullai/auth';
import { apiBaseUrl } from '@0xnullai/settings';
import {
  createEmptyDeviceState,
  type SessionMessagePage,
  type SessionSnapshot,
  type SessionStore,
} from '@dg-agent/core';

export type ServerSession = Pick<
  SessionSnapshot,
  'id' | 'createdAt' | 'updatedAt' | 'messages' | 'metadata'
>;
export interface ConversationItem {
  id: string;
  revision: number;
  lastSequence?: number;
  messageCount?: number;
  updatedAt: number;
  deleted: boolean;
  session: ServerSession | null;
}
export class ConversationStoreError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}
const version = Symbol('server-session-version');
const observedSequence = Symbol('observed-conversation-sequence');
const observedMessageCount = Symbol('observed-conversation-message-count');
const runtimeWindow = Symbol('runtime-conversation-window');
interface Version {
  account: string | null;
  generation: number;
  revision: number;
  persisted?: ServerSession;
}
type VersionedSession = SessionSnapshot & {
  [version]?: Version;
  [observedSequence]?: number;
  [observedMessageCount]?: number;
  [runtimeWindow]?: true;
};

function incrementalMessages(before: ServerSession | undefined, current: ServerSession) {
  if (
    !before ||
    JSON.stringify(before.metadata) !== JSON.stringify(current.metadata) ||
    before.messages.length > current.messages.length
  )
    return null;
  const extended: ServerSession['messages'] = [];
  for (const [index, message] of before.messages.entries()) {
    const next = current.messages[index];
    if (!next) return null;
    if (JSON.stringify(message) === JSON.stringify(next)) continue;
    if (
      message.role !== 'assistant' ||
      next.role !== 'assistant' ||
      message.kind !== undefined ||
      next.kind !== undefined ||
      message.id !== next.id ||
      message.createdAt !== next.createdAt ||
      !next.content.startsWith(message.content)
    )
      return null;
    extended.push(next);
  }
  const added = current.messages.slice(before.messages.length);
  if (
    extended.length + added.length === 0 ||
    extended.length + added.length > 20 ||
    added.some(
      (message) => message.kind !== undefined || !['user', 'assistant'].includes(message.role),
    )
  )
    return null;
  return [...extended, ...added];
}
function samePublicContent(before: ServerSession | undefined, current: ServerSession): boolean {
  return Boolean(
    before &&
    before.id === current.id &&
    before.createdAt === current.createdAt &&
    JSON.stringify(before.metadata) === JSON.stringify(current.metadata) &&
    JSON.stringify(before.messages) === JSON.stringify(current.messages),
  );
}
function metadataChanges(before: ServerSession | undefined, current: ServerSession) {
  if (
    !before ||
    before.id !== current.id ||
    before.createdAt !== current.createdAt ||
    JSON.stringify(before.messages) !== JSON.stringify(current.messages) ||
    before.metadata?.promptPresetId !== current.metadata?.promptPresetId ||
    before.metadata?.relationshipId !== current.metadata?.relationshipId
  )
    return null;
  const changes: { sessionTitle?: string | null; sceneId?: string | null } = {};
  if (before.metadata?.sessionTitle !== current.metadata?.sessionTitle)
    changes.sessionTitle =
      typeof current.metadata?.sessionTitle === 'string' ? current.metadata.sessionTitle : null;
  if (before.metadata?.sceneId !== current.metadata?.sceneId)
    changes.sceneId =
      typeof current.metadata?.sceneId === 'string' ? current.metadata.sceneId : null;
  return Object.keys(changes).length ? changes : null;
}

/** Sequence read with this exact server snapshot, never a newer inbox summary. */
export function getObservedConversationSequence(
  session: SessionSnapshot | null,
  account: string | null,
): number | null {
  const versioned = session as VersionedSession | null;
  if (!account || versioned?.[version]?.account !== account) return null;
  const sequence = versioned[observedSequence];
  return typeof sequence === 'number' && Number.isSafeInteger(sequence) && sequence >= 0
    ? sequence
    : null;
}
export interface ServerSessionStoreOptions {
  accountId?: () => string | null;
  subscribeAccount?: (listener: () => void) => () => void;
  request?: typeof fetch;
  migrateLegacy?: boolean;
}

/** Explicit public-history projection; device grants, tool payloads and raw diagnostics never travel. */
export function toServerSession(session: SessionSnapshot): ServerSession {
  const metadata: Record<string, unknown> = {};
  for (const key of ['sessionTitle', 'relationshipId', 'promptPresetId', 'sceneId']) {
    if (typeof session.metadata?.[key] === 'string') metadata[key] = session.metadata[key];
  }
  return {
    id: session.id,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messages: session.messages.map(({ id, role, content, createdAt, kind }) => ({
      id,
      role,
      content,
      createdAt,
      ...(kind === 'camera_observation' ? { kind } : {}),
    })),
    metadata,
  };
}

/** Server is the only durable history. No IndexedDB fallback, background upload or blind conflict retry. */
export class ServerSessionStore implements SessionStore {
  private readonly accountId: () => string | null;
  private readonly request: typeof fetch;
  private readonly unsubscribe: () => void;
  private generation = 0;
  private migration: Promise<void> | null = null;
  private readonly migrateLegacy: boolean;
  private queues = new Map<string, Promise<unknown>>();
  private operational = new Map<string, Pick<SessionSnapshot, 'deviceState' | 'metadata'>>();
  /**
   * Latest server version per conversation for this account generation. The runtime can
   * save a fresh snapshot object of a conversation it already saved; without this, that
   * copy would start again at revision 0 and its create would conflict with the first.
   */
  private known = new Map<string, Version>();
  constructor(options: ServerSessionStoreOptions = {}) {
    this.migrateLegacy = options.migrateLegacy ?? true;
    this.accountId = options.accountId ?? currentAuthUserId;
    // Browsers reject `fetch` called as a method of another object ("Illegal invocation"),
    // so the default must not be stored as a bare reference and invoked via `this.request`.
    this.request = options.request ?? ((input, init) => fetch(input, init));
    let activeAccount = this.accountId();
    this.unsubscribe = (options.subscribeAccount ?? subscribeAuthChanges)(() => {
      const nextAccount = this.accountId();
      if (nextAccount === activeAccount) return;
      activeAccount = nextAccount;
      this.generation++;
      this.migration = null;
      this.queues.clear();
      this.operational.clear();
      this.known.clear();
    });
  }
  dispose(): void {
    this.unsubscribe();
    this.generation++;
    this.operational.clear();
    this.known.clear();
  }
  private identity(): Version {
    return { account: this.accountId(), generation: this.generation, revision: 0 };
  }
  private assertIdentity(identity: Version): void {
    if (identity.account !== this.accountId() || identity.generation !== this.generation)
      throw new ConversationStoreError('账户已变化，请重新打开会话。', 403);
  }
  private async call(
    identity: Version,
    suffix = '',
    init: RequestInit = {},
  ): Promise<
    | ConversationItem
    | {
        items: ConversationItem[];
        nextCursor: string | null;
        migrationErrors?: Array<{ id: string; error: string }>;
      }
    | null
  > {
    this.assertIdentity(identity);
    if (!identity.account)
      throw new ConversationStoreError('请先登录，再开始聊天；聊天记录由服务器保存。', 401);
    const response = await this.request(`${apiBaseUrl()}/api/auth/conversations${suffix}`, {
      ...init,
      credentials: 'include',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        ...authRequestHeaders(),
        'x-account-id': identity.account,
      },
    });
    this.assertIdentity(identity);
    if (response.status === 404 || response.status === 410) return null;
    if (!response.ok)
      throw new ConversationStoreError(
        response.status === 409
          ? '会话已在另一端更新，请重新打开会话后重试。未覆盖服务器记录。'
          : response.status === 401
            ? '登录已过期，请重新登录后重试。'
            : '服务器未能保存或读取会话，请检查网络后重试。',
        response.status,
      );
    const result: unknown = await response.json();
    this.assertIdentity(identity);
    return result as
      | ConversationItem
      | {
          items: ConversationItem[];
          nextCursor: string | null;
          migrationErrors?: Array<{ id: string; error: string }>;
        };
  }
  private hydrate(item: ConversationItem, identity: Version): SessionSnapshot | null {
    if (item.deleted || !item.session) return null;
    const local = this.operational.get(item.id);
    const session: VersionedSession = {
      ...item.session,
      deviceState: local?.deviceState ?? createEmptyDeviceState(),
      metadata: { ...local?.metadata, ...item.session.metadata },
      [version]: {
        ...identity,
        revision: item.revision,
        persisted: toServerSession({ ...item.session, deviceState: createEmptyDeviceState() }),
      },
      [observedSequence]: item.lastSequence,
      [observedMessageCount]: item.messageCount,
    };
    return session;
  }
  async get(id: string): Promise<SessionSnapshot | null> {
    const identity = this.identity();
    if (!identity.account) return null;
    const item = (await this.call(
      identity,
      `/${encodeURIComponent(id)}`,
    )) as ConversationItem | null;
    return item ? this.hydrate(item, identity) : null;
  }
  async getRecent(id: string): Promise<SessionSnapshot | null> {
    const identity = this.identity();
    if (!identity.account) return null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const item = (await this.call(
        identity,
        `/${encodeURIComponent(id)}?window=20`,
      )) as ConversationItem | null;
      if (!item || item.deleted || !item.session) return null;
      const page = (await this.messagesPage(id)) as SessionMessagePage & {
        revision?: number;
        lastSequence?: number;
        messageCount?: number;
      };
      const messages = page.items.map(({ sequence: _sequence, ...message }) => message);
      if (page.revision !== undefined) {
        if (
          page.revision !== item.revision ||
          page.lastSequence !== item.lastSequence ||
          page.messageCount !== item.messageCount ||
          JSON.stringify(messages) !== JSON.stringify(item.session.messages)
        )
          continue;
      } else if ((page.items.at(-1)?.sequence ?? 0) !== (item.lastSequence ?? 0)) continue;
      const session = this.hydrate(item, identity);
      if (!session) return null;
      return {
        ...session,
        messages,
        historyWindow: { nextBefore: page.nextBefore },
      };
    }
    throw new ConversationStoreError('会话正在另一端更新，请重试读取。', 409);
  }
  async getRuntimeWindow(id: string): Promise<SessionSnapshot | null> {
    const recent = await this.getRecent(id);
    if (!recent) return null;
    const { historyWindow: _historyWindow, ...runtime } = recent;
    return { ...runtime, [runtimeWindow]: true } as VersionedSession;
  }
  async getCompleteByPages(id: string): Promise<SessionSnapshot | null> {
    const identity = this.identity();
    const initial = (await this.getRecent(id)) as VersionedSession | null;
    if (!initial) return null;
    const revision = initial[version]?.revision;
    const lastSequence = initial[observedSequence] ?? 0;
    const messageCount = initial[observedMessageCount];
    const pages: SessionSnapshot['messages'][] = [initial.messages];
    const sequences = new Set<number>();
    let before = initial.historyWindow?.nextBefore ?? null;
    const seen = new Set<number>();
    while (before !== null) {
      if (seen.has(before)) throw new ConversationStoreError('历史消息分页无进展，请重试导出。');
      seen.add(before);
      const page = await this.messagesPage(id, before);
      if (!page.items.length || page.items.at(-1)!.sequence >= before)
        throw new ConversationStoreError('历史消息分页不连续，请重试导出。');
      for (const message of page.items) {
        if (sequences.has(message.sequence))
          throw new ConversationStoreError('历史消息分页重复，请重试导出。');
        sequences.add(message.sequence);
      }
      pages.push(page.items.map(({ sequence: _sequence, ...message }) => message));
      before = page.nextBefore;
    }
    const messages = pages.reverse().flat();
    const final = (await this.getRecent(id)) as VersionedSession | null;
    this.assertIdentity(identity);
    if (
      !final ||
      revision !== final[version]?.revision ||
      lastSequence !== final[observedSequence] ||
      messageCount !== final[observedMessageCount] ||
      messages.length !== (messageCount ?? lastSequence)
    )
      throw new ConversationStoreError('导出期间会话发生变化，请重新导出。', 409);
    return {
      id: initial.id,
      createdAt: initial.createdAt,
      updatedAt: initial.updatedAt,
      metadata: initial.metadata,
      deviceState: initial.deviceState,
      messages,
    };
  }
  async search(query: string): Promise<string[]> {
    const identity = this.identity();
    if (!identity.account) return [];
    const normalized = query.trim();
    if (normalized.length < 2 || normalized.length > 100) return [];
    const result = (await this.call(identity, `/search?q=${encodeURIComponent(normalized)}`)) as {
      ids: string[];
    } | null;
    return result?.ids ?? [];
  }
  async messagesPage(id: string, before?: number): Promise<SessionMessagePage> {
    const identity = this.identity();
    if (!identity.account) throw new ConversationStoreError('请先登录，再查看历史消息。', 401);
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1))
      throw new ConversationStoreError('消息分页条件无效', 400);
    const suffix = `/${encodeURIComponent(id)}/messages?limit=20${before ? `&before=${before}` : ''}`;
    const result = (await this.call(identity, suffix)) as unknown as SessionMessagePage | null;
    if (!result) throw new ConversationStoreError('会话不存在或已删除', 404);
    return result;
  }
  private async finishLegacyMigration(identity: Version): Promise<void> {
    if (this.migrateLegacy && identity.account) {
      this.migration ??= migrateOwnedBrowserSessions(
        this,
        identity.account,
        () => identity.account === this.accountId() && identity.generation === this.generation,
      )
        .then(({ retained }) => {
          if (retained) this.warnMigration();
        })
        .catch(() => this.warnMigration());
      await this.migration;
      this.assertIdentity(identity);
    }
  }
  async listSummaries(): Promise<SessionSnapshot[]> {
    const identity = this.identity();
    if (!identity.account) return [];
    await this.finishLegacyMigration(identity);
    type Summary = {
      id: string;
      createdAt: number;
      updatedAt: number;
      deleted: boolean;
      metadata: Record<string, string>;
      preview: string;
      hasUserMessage: boolean;
    };
    const items = new Map<string, Summary>();
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const page = (await this.call(
        identity,
        `?summary=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      )) as unknown as {
        items: Summary[];
        nextCursor: string | null;
        migrationErrors?: Array<{ id: string; error: string }>;
      };
      if (page.migrationErrors?.length)
        this.warnMigration('部分服务器旧会话格式需要修复，原始数据已保留；其余会话可继续使用。');
      for (const item of page.items) if (!item.deleted) items.set(item.id, item);
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor))
        throw new ConversationStoreError('服务器分页无进展，请重试。');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return [...items.values()]
      .map((item): SessionSnapshot => ({
        id: item.id,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        messages: [],
        metadata: item.metadata,
        deviceState: createEmptyDeviceState(),
        listSummary: { hasUserMessage: item.hasUserMessage, preview: item.preview },
      }))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }
  async list(): Promise<SessionSnapshot[]> {
    const identity = this.identity();
    if (!identity.account) return [];
    await this.finishLegacyMigration(identity);
    const items = new Map<string, ConversationItem>();
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const page = (await this.call(
        identity,
        cursor ? `?cursor=${encodeURIComponent(cursor)}` : '',
      )) as {
        items: ConversationItem[];
        nextCursor: string | null;
        migrationErrors?: Array<{ id: string; error: string }>;
      };
      if (page.migrationErrors?.length)
        this.warnMigration('部分服务器旧会话格式需要修复，原始数据已保留；其余会话可继续使用。');
      for (const item of page.items) {
        if ((items.get(item.id)?.revision ?? -1) < item.revision) items.set(item.id, item);
      }
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor))
        throw new ConversationStoreError('服务器分页无进展，请重试。');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return [...items.values()]
      .map((item) => this.hydrate(item, identity))
      .filter((session): session is SessionSnapshot => session !== null)
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }
  private warnMigration(
    message = '部分旧记录尚未完成服务器验证，已保留在本机，请稍后重试迁移。',
  ): void {
    if (typeof window !== 'undefined')
      window.dispatchEvent(
        new CustomEvent('0xnullai:conversation-warning', {
          detail: message,
        }),
      );
  }
  private rememberOperational(session: SessionSnapshot): void {
    const privateMetadata = { ...session.metadata };
    for (const key of ['sessionTitle', 'relationshipId', 'promptPresetId', 'sceneId'])
      delete privateMetadata[key];
    this.operational.set(session.id, {
      deviceState: session.deviceState,
      metadata: privateMetadata,
    });
  }
  save(session: VersionedSession): Promise<void> {
    if (session.historyWindow)
      throw new ConversationStoreError('近期消息仅供显示，不能覆盖完整聊天记录。', 400);
    const known = this.known.get(session.id);
    const identity =
      session[version] ??
      (known && known.account === this.accountId() && known.generation === this.generation
        ? known
        : this.identity());
    this.assertIdentity(identity);
    session[version] = identity;
    this.known.set(session.id, identity);
    // Runtime creates an empty session while mounting. Signed-out browsing remains usable,
    // but the first real user message must pass authenticated server persistence.
    if (!identity.account && session.messages.length === 0) {
      session[version] = identity;
      return Promise.resolve();
    }
    const body = toServerSession(session);
    const run = async () => {
      this.assertIdentity(identity);
      if (identity.revision > 0 && samePublicContent(identity.persisted, body)) {
        this.rememberOperational(session);
        return;
      }
      const baseline = identity.persisted;
      const combinedAdditions =
        baseline && incrementalMessages(baseline, { ...body, metadata: baseline.metadata });
      const combinedChanges =
        baseline && metadataChanges(baseline, { ...body, messages: baseline.messages });
      if (identity.revision > 0 && combinedAdditions && combinedChanges) {
        const patched = (await this.call(identity, `/${encodeURIComponent(session.id)}/metadata`, {
          method: 'PUT',
          body: JSON.stringify({ expectedRevision: identity.revision, changes: combinedChanges }),
        })) as { revision: number } | null;
        if (!patched) throw new ConversationStoreError('会话已删除，请创建新会话。', 410);
        identity.revision = patched.revision;
        identity.persisted = { ...baseline, metadata: body.metadata };
        const appended = (await this.call(identity, `/${encodeURIComponent(session.id)}/messages`, {
          method: 'POST',
          body: JSON.stringify({
            expectedRevision: identity.revision,
            messages: combinedAdditions,
          }),
        })) as { revision: number } | null;
        if (!appended) throw new ConversationStoreError('会话已删除，请创建新会话。', 410);
        identity.revision = appended.revision;
        identity.persisted = body;
        session[version] = identity;
        this.rememberOperational(session);
        if (typeof window !== 'undefined')
          window.dispatchEvent(new Event('0xnullai:conversation-updated'));
        return;
      }
      const additions = incrementalMessages(identity.persisted, body);
      if (identity.revision > 0 && additions) {
        const baseline = identity.persisted!;
        let revision = identity.revision;
        let merged = body;
        let result: { revision: number; lastSequence: number } | null = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            result = (await this.call(identity, `/${encodeURIComponent(session.id)}/messages`, {
              method: 'POST',
              body: JSON.stringify({ expectedRevision: revision, messages: additions }),
            })) as { revision: number; lastSequence: number } | null;
            break;
          } catch (error) {
            if (
              !(error instanceof ConversationStoreError) ||
              error.status !== 409 ||
              attempt === 2 ||
              additions.some((message) => baseline.messages.some((old) => old.id === message.id))
            )
              throw error;
            const latest = (await this.getRecent(session.id)) as VersionedSession | null;
            this.assertIdentity(identity);
            const remoteMetadata = latest ? toServerSession(latest).metadata : null;
            if (
              !latest ||
              latest.createdAt !== baseline.createdAt ||
              !remoteMetadata ||
              JSON.stringify(Object.entries(remoteMetadata).sort()) !==
                JSON.stringify(Object.entries(baseline.metadata ?? {}).sort())
            )
              throw error;
            const latestVersion = latest[version];
            const latestCount = latest[observedMessageCount];
            if (!latestVersion || latestCount === undefined) throw error;
            let remoteTail: ServerSession['messages'];
            if (baseline.messages.length) {
              const anchor = baseline.messages.at(-1)!;
              const index = latest.messages.findIndex((message) => message.id === anchor.id);
              if (index < 0) throw error;
              const overlap = latest.messages.slice(0, index + 1);
              if (
                JSON.stringify(overlap) !== JSON.stringify(baseline.messages.slice(-overlap.length))
              )
                throw error;
              remoteTail = latest.messages.slice(index + 1);
            } else {
              if (latestCount !== latest.messages.length) throw error;
              remoteTail = latest.messages;
            }
            const alreadyRemote = new Map(remoteTail.map((message) => [message.id, message]));
            if (
              additions.some((message) => {
                const remote = alreadyRemote.get(message.id);
                return remote && JSON.stringify(remote) !== JSON.stringify(message);
              })
            )
              throw error;
            merged = {
              ...body,
              messages: [
                ...baseline.messages,
                ...remoteTail,
                ...additions.filter((message) => !alreadyRemote.has(message.id)),
              ],
            };
            revision = latestVersion.revision;
          }
        }
        if (!result) throw new ConversationStoreError('会话已删除，请创建新会话。', 410);
        identity.revision = result.revision;
        session[version] = identity;
        identity.persisted = merged;
        if (merged !== body) {
          const localMessages = new Map(session.messages.map((message) => [message.id, message]));
          session.messages.splice(
            0,
            session.messages.length,
            ...merged.messages.map((message) => localMessages.get(message.id) ?? message),
          );
        }
        session[observedSequence] = result.lastSequence;
        this.rememberOperational(session);
        if (typeof window !== 'undefined')
          window.dispatchEvent(new Event('0xnullai:conversation-updated'));
        return;
      }
      const changes = metadataChanges(identity.persisted, body);
      if (identity.revision > 0 && changes) {
        const result = (await this.call(identity, `/${encodeURIComponent(session.id)}/metadata`, {
          method: 'PUT',
          body: JSON.stringify({ expectedRevision: identity.revision, changes }),
        })) as { revision: number; metadata: Record<string, string> } | null;
        if (!result) throw new ConversationStoreError('会话已删除，请创建新会话。', 410);
        identity.revision = result.revision;
        identity.persisted = body;
        session[version] = identity;
        this.rememberOperational(session);
        if (typeof window !== 'undefined')
          window.dispatchEvent(new Event('0xnullai:conversation-updated'));
        return;
      }
      if (session[runtimeWindow])
        throw new ConversationStoreError(
          '近期运行窗口只能追加消息或修改标题和场景，不能重写完整历史。',
          400,
        );
      const item = (await this.call(identity, `/${encodeURIComponent(session.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ expectedRevision: identity.revision, session: body }),
      })) as ConversationItem | null;
      if (!item || item.deleted || !item.session)
        throw new ConversationStoreError('会话已删除，请创建新会话。', 410);
      if (typeof window !== 'undefined')
        window.dispatchEvent(new Event('0xnullai:conversation-updated'));
      identity.revision = item.revision;
      session[version] = identity;
      identity.persisted = body;
      this.rememberOperational(session);
    };
    const pending = (this.queues.get(session.id) ?? Promise.resolve()).then(run);
    this.queues.set(
      session.id,
      pending.catch(() => undefined),
    );
    return pending;
  }
  async delete(id: string): Promise<void> {
    this.known.delete(id);
    const identity = this.identity();
    await this.queues.get(id);
    const item = (await this.call(
      identity,
      `/${encodeURIComponent(id)}`,
    )) as ConversationItem | null;
    if (!item || item.deleted) return;
    await this.call(identity, `/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      body: JSON.stringify({ expectedRevision: item.revision }),
    });
    this.operational.delete(id);
    if (typeof window !== 'undefined')
      window.dispatchEvent(new Event('0xnullai:conversation-updated'));
  }
}
