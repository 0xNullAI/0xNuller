import { describe, expect, it, vi } from 'vitest';
import { createEmptyDeviceState, type SessionSnapshot } from '@dg-agent/core';
import {
  ServerSessionStore,
  getObservedConversationSequence,
  toServerSession,
  type ConversationItem,
  type ServerSession,
} from './server-session-store.js';

function snapshot(id = 's'): SessionSnapshot {
  return { id, createdAt: 1, updatedAt: 1, messages: [], deviceState: createEmptyDeviceState() };
}
function harness() {
  let account: string | null = 'alice';
  let listener = () => {};
  const rows = new Map<string, ConversationItem>();
  const request = vi.fn<typeof fetch>(async (url, init) => {
    const parsed = new URL(String(url), 'https://test');
    if (parsed.pathname.endsWith('/search')) {
      const q = (parsed.searchParams.get('q') ?? '').toLowerCase();
      return Response.json({
        ids: [...rows.values()]
          .filter(
            (item) =>
              !item.deleted &&
              item.session?.messages.some((message) => message.content.toLowerCase().includes(q)),
          )
          .map((item) => item.id),
      });
    }
    if (parsed.pathname.endsWith('/conversations') && parsed.searchParams.get('summary') === '1') {
      return Response.json({
        items: [...rows.values()].map((item) => ({
          id: item.id,
          createdAt: item.session?.createdAt ?? 1,
          updatedAt: item.updatedAt,
          deleted: item.deleted,
          metadata: item.session?.metadata ?? {},
          preview: item.session?.messages.at(-1)?.content ?? '',
          hasUserMessage:
            item.session?.messages.some((message) => message.role === 'user') ?? false,
        })),
        nextCursor: null,
      });
    }
    if (init?.method !== 'POST' && parsed.pathname.endsWith('/messages')) {
      const conversationId = parsed.pathname.split('/').at(-2)!;
      const row = rows.get(conversationId);
      const messages = row?.session?.messages ?? [];
      const before = Number(parsed.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER);
      const earlier = messages
        .map((message, index) => ({ ...message, sequence: index + 1 }))
        .filter((message) => message.sequence < before);
      const page = earlier.slice(-20);
      return Response.json({
        items: page,
        nextBefore: earlier.length > 20 ? page[0]?.sequence : null,
        revision: row?.revision,
        lastSequence: row?.lastSequence,
        messageCount: row?.messageCount ?? messages.length,
      });
    }
    if (init?.method === 'PUT' && String(url).endsWith('/metadata')) {
      const conversationId = String(url).split('/').at(-2)!;
      const current = rows.get(conversationId);
      if (!current?.session) return Response.json({}, { status: 404 });
      const body = JSON.parse(String(init.body)) as {
        expectedRevision: number;
        changes: { sessionTitle?: string | null; sceneId?: string | null };
      };
      if (body.expectedRevision !== current.revision) return Response.json({}, { status: 409 });
      const metadata = { ...current.session.metadata };
      if ('sessionTitle' in body.changes) {
        if (body.changes.sessionTitle === null) delete metadata.sessionTitle;
        else metadata.sessionTitle = body.changes.sessionTitle;
      }
      if ('sceneId' in body.changes) metadata.sceneId = body.changes.sceneId ?? '';
      const next = {
        ...current,
        revision: current.revision + 1,
        session: { ...current.session, metadata },
      };
      rows.set(conversationId, next);
      return Response.json({ revision: next.revision, metadata, updatedAt: next.updatedAt });
    }
    if (init?.method === 'PUT' && String(url).endsWith('/relationship')) {
      const conversationId = String(url).split('/').at(-2)!;
      const current = rows.get(conversationId);
      if (!current?.session) return Response.json({}, { status: 404 });
      const body = JSON.parse(String(init.body)) as {
        expectedRevision: number;
        relationshipId: string;
      };
      const bound = current.session.metadata?.relationshipId;
      if (body.expectedRevision !== current.revision || (bound && bound !== body.relationshipId))
        return Response.json({}, { status: 409 });
      const next = {
        ...current,
        revision: current.revision + 1,
        session: {
          ...current.session,
          metadata: { ...current.session.metadata, relationshipId: body.relationshipId },
        },
      };
      rows.set(conversationId, next);
      return Response.json(next);
    }
    if (init?.method === 'POST' && String(url).endsWith('/messages')) {
      const conversationId = String(url).split('/').at(-2)!;
      const current = rows.get(conversationId);
      if (!current?.session) return Response.json({}, { status: 404 });
      const body = JSON.parse(String(init.body)) as {
        expectedRevision: number;
        messages: ServerSession['messages'];
      };
      if (body.expectedRevision !== current.revision) return Response.json({}, { status: 409 });
      const existing = new Map(current.session.messages.map((message) => [message.id, message]));
      if (
        body.messages.some((message) => {
          const old = existing.get(message.id);
          return (
            old &&
            JSON.stringify(old) !== JSON.stringify(message) &&
            !(
              old.role === 'assistant' &&
              message.role === 'assistant' &&
              old.createdAt === message.createdAt &&
              message.content.startsWith(old.content)
            )
          );
        })
      )
        return Response.json({}, { status: 409 });
      const added = body.messages.filter((message) => !existing.has(message.id));
      const extended = body.messages.filter((message) => {
        const old = existing.get(message.id);
        return old && old.content !== message.content;
      });
      const next = {
        ...current,
        revision: current.revision + (added.length || extended.length ? 1 : 0),
        lastSequence: current.session.messages.length + added.length,
        messageCount: current.session.messages.length + added.length,
        session: {
          ...current.session,
          messages: [
            ...current.session.messages.map(
              (message) => extended.find((item) => item.id === message.id) ?? message,
            ),
            ...added,
          ],
        },
      };
      rows.set(conversationId, next);
      return Response.json({
        revision: next.revision,
        lastSequence: next.session.messages.length,
        added: added.length,
        extended: extended.length,
      });
    }
    const id = parsed.pathname.split('/').at(-1)!;
    const old = rows.get(id);
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body));
      if (body.expectedRevision !== (old?.revision ?? 0)) return Response.json({}, { status: 409 });
      const item = {
        id,
        session: body.session,
        revision: (old?.revision ?? 0) + 1,
        lastSequence: body.session.messages.length,
        messageCount: body.session.messages.length,
        updatedAt: 1,
        deleted: false,
      };
      rows.set(id, item);
      return Response.json(item);
    }
    if (init?.method === 'DELETE') {
      if (old) rows.set(id, { ...old, deleted: true, session: null });
      return Response.json({ ...old, deleted: true, session: null });
    }
    if (id === 'conversations')
      return Response.json({ items: [...rows.values()], nextCursor: null });
    return old
      ? Response.json(
          parsed.searchParams.get('window') === '20' && old.session
            ? { ...old, session: { ...old.session, messages: old.session.messages.slice(-20) } }
            : old,
          { status: old.deleted ? 410 : 200 },
        )
      : Response.json({}, { status: 404 });
  });
  const store = new ServerSessionStore({
    request,
    migrateLegacy: false,
    accountId: () => account,
    subscribeAccount: (cb) => {
      listener = cb;
      return () => {};
    },
  });
  return {
    store,
    request,
    rows,
    switchAccount(next: string | null) {
      account = next;
      listener();
    },
  };
}

describe('server-only session storage', () => {
  it('preserves the server observation kind during ordinary subsequent saves', () => {
    const session = snapshot();
    session.messages.push({
      id: 'c',
      role: 'assistant',
      content: '画面',
      createdAt: 2,
      kind: 'camera_observation',
    });
    expect(toServerSession(session).messages[0]).toMatchObject({ kind: 'camera_observation' });
  });
  it('saves a second snapshot object of a just-created conversation without a create conflict', async () => {
    const h = harness();
    const first = snapshot('fresh');
    const second = snapshot('fresh');
    // The runtime saves a new conversation and then a separate copy of it, concurrently.
    await Promise.all([h.store.save(first), h.store.save(second)]);
    second.messages.push({ id: 'm1', role: 'user', content: '你好', createdAt: 2 });
    await expect(h.store.save(second)).resolves.toBeUndefined();
    expect(h.rows.get('fresh')?.session?.messages.map((message) => message.id)).toEqual(['m1']);
  });
  it('keeps the observed server sequence with the loaded snapshot without uploading it', async () => {
    const h = harness();
    h.rows.set('s', {
      id: 's',
      revision: 1,
      lastSequence: 3,
      updatedAt: 1,
      deleted: false,
      session: toServerSession(snapshot()),
    });
    const loaded = (await h.store.get('s'))!;
    expect(getObservedConversationSequence(loaded, 'alice')).toBe(3);
    expect(getObservedConversationSequence(loaded, 'bob')).toBeNull();
    expect(getObservedConversationSequence(snapshot(), 'alice')).toBeNull();
    expect(toServerSession(loaded)).not.toHaveProperty('lastSequence');
    expect(JSON.stringify(toServerSession(loaded))).not.toContain('observed-conversation-sequence');
  });
  it('loads navigation summaries and server search without downloading transcript bodies', async () => {
    const h = harness();
    const session = snapshot();
    session.messages = [{ id: 'm', role: 'user', content: 'private memory', createdAt: 1 }];
    await h.store.save(session);
    const listed = await h.store.listSummaries();
    expect(listed).toMatchObject([
      {
        id: 's',
        messages: [],
        listSummary: {
          hasUserMessage: true,
          preview: 'private memory',
        },
      },
    ]);
    expect(await h.store.search('memory')).toEqual(['s']);
    expect(h.request.mock.calls.some(([url]) => String(url).includes('?summary=1'))).toBe(true);
    expect(h.request.mock.calls.some(([url]) => String(url).includes('/search?q=memory'))).toBe(
      true,
    );
    expect((await h.store.get('s'))?.messages).toHaveLength(1);
  });
  it('pages older server messages by sequence without trusting local display state', async () => {
    const h = harness();
    const session = snapshot();
    session.messages = Array.from({ length: 45 }, (_, index) => ({
      id: `m${index}`,
      role: 'user' as const,
      content: `text ${index}`,
      createdAt: index,
    }));
    await h.store.save(session);
    const latest = await h.store.messagesPage('s');
    expect(latest.items.map((message) => message.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => `m${index + 25}`),
    );
    expect(latest.nextBefore).toBe(26);
    const earlier = await h.store.messagesPage('s', latest.nextBefore!);
    expect(earlier.items[0]?.id).toBe('m5');
    expect(earlier.nextBefore).toBe(6);
    await expect(h.store.messagesPage('s', 0)).rejects.toMatchObject({ status: 400 });
  });
  it('marks recent display snapshots read-only so a window cannot overwrite older messages', async () => {
    const h = harness();
    const session = snapshot();
    session.messages = Array.from({ length: 45 }, (_, index) => ({
      id: `m${index}`,
      role: 'user' as const,
      content: `text ${index}`,
      createdAt: index,
    }));
    await h.store.save(session);
    const recent = (await h.store.getRecent('s'))!;
    expect(recent.messages).toHaveLength(20);
    expect(recent.historyWindow?.nextBefore).toBe(26);
    expect(() => h.store.save(recent)).toThrow('不能覆盖完整聊天记录');
    expect((await h.store.get('s'))?.messages).toHaveLength(45);
  });
  it('appends from a bounded runtime window but rejects a partial-history rewrite', async () => {
    const h = harness();
    const session = snapshot();
    session.metadata = { promptPresetId: 'character' };
    session.messages = Array.from({ length: 45 }, (_, index) => ({
      id: `m${index}`,
      role: 'user' as const,
      content: `text ${index}`,
      createdAt: index,
    }));
    await h.store.save(session);
    h.request.mockClear();
    const runtime = (await h.store.getRuntimeWindow('s'))!;
    expect(runtime.messages).toHaveLength(20);
    expect(runtime.historyWindow).toBeUndefined();
    runtime.messages.push({ id: 'new', role: 'user', content: 'new text', createdAt: 46 });
    await h.store.save(runtime);
    expect(
      h.request.mock.calls.some(
        ([url, init]) => init?.method === 'POST' && String(url).endsWith('/messages'),
      ),
    ).toBe(true);
    expect(h.request.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
    expect((await h.store.get('s'))?.messages).toHaveLength(46);
    runtime.messages[0]!.content = 'rewritten';
    await expect(h.store.save(runtime)).rejects.toMatchObject({ status: 400 });
    expect((await h.store.get('s'))?.messages[25]?.content).toBe('text 25');
  });
  it('binds a relationship that arrived after the first message, then keeps appending', async () => {
    const h = harness();
    const session = snapshot();
    session.metadata = { promptPresetId: 'character' };
    session.messages = [{ id: 'm0', role: 'user', content: '你好', createdAt: 1 }];
    await h.store.save(session);
    const runtime = (await h.store.getRuntimeWindow('s'))!;
    runtime.metadata = { ...runtime.metadata, relationshipId: 'rel-1' };
    runtime.messages.push({ id: 'm1', role: 'user', content: '还记得我吗', createdAt: 2 });
    h.request.mockClear();
    await h.store.save(runtime);
    const calls = h.request.mock.calls.map(
      ([url, init]) => `${init?.method} ${String(url).split('/').at(-1)}`,
    );
    expect(calls).toEqual(['PUT relationship', 'POST messages']);
    const saved = await h.store.get('s');
    expect(saved?.metadata.relationshipId).toBe('rel-1');
    expect(saved?.messages.map((message) => message.id)).toEqual(['m0', 'm1']);
  });

  it('commits a scene change and new message from a bounded runtime window without replacing history', async () => {
    const h = harness();
    const session = snapshot();
    session.metadata = { promptPresetId: 'character', sceneId: 'old' };
    session.messages = Array.from({ length: 45 }, (_, index) => ({
      id: `m${index}`,
      role: 'user' as const,
      content: `text ${index}`,
      createdAt: index,
    }));
    await h.store.save(session);
    h.request.mockClear();
    const runtime = (await h.store.getRuntimeWindow('s'))!;
    runtime.metadata.sceneId = 'new';
    runtime.messages.push({ id: 'new', role: 'user', content: 'new text', createdAt: 46 });
    await h.store.save(runtime);
    expect(
      h.request.mock.calls.filter(
        ([url, init]) => init?.method === 'PUT' && String(url).endsWith('/metadata'),
      ),
    ).toHaveLength(1);
    expect(
      h.request.mock.calls.filter(
        ([url, init]) => init?.method === 'POST' && String(url).endsWith('/messages'),
      ),
    ).toHaveLength(1);
    expect(
      h.request.mock.calls.some(
        ([url, init]) => init?.method === 'PUT' && !String(url).endsWith('/metadata'),
      ),
    ).toBe(false);
    const saved = await h.store.get('s');
    expect(saved?.metadata.sceneId).toBe('new');
    expect(saved?.messages).toHaveLength(46);
  });
  it('exports every page and rejects a transcript changed midway through export', async () => {
    const h = harness();
    const session = snapshot();
    session.messages = Array.from({ length: 45 }, (_, index) => ({
      id: `m${index}`,
      role: 'user' as const,
      content: `text ${index}`,
      createdAt: index,
    }));
    await h.store.save(session);
    h.request.mockClear();
    const complete = (await h.store.getCompleteByPages('s'))!;
    expect(complete.messages.map((message) => message.id)).toEqual(
      Array.from({ length: 45 }, (_, index) => `m${index}`),
    );
    expect(complete.historyWindow).toBeUndefined();
    expect(
      h.request.mock.calls.some(
        ([url]) => /\/s(?:$|\?)/.test(String(url)) && !String(url).includes('window=20'),
      ),
    ).toBe(false);

    const base = h.request.getMockImplementation()!;
    h.request.mockImplementation(async (url, init) => {
      const response = await base(url, init);
      if (String(url).includes('before=')) {
        const row = h.rows.get('s')!;
        h.rows.set('s', { ...row, revision: row.revision + 1 });
      }
      return response;
    });
    await expect(h.store.getCompleteByPages('s')).rejects.toMatchObject({ status: 409 });
  });

  it('restores and exports retained history after a terminal camera observation is cancelled', async () => {
    const h = harness();
    const session = snapshot();
    session.messages = Array.from({ length: 25 }, (_, index) => ({
      id: `m${index}`,
      role: 'user' as const,
      content: `text ${index}`,
      createdAt: index,
    }));
    await h.store.save(session);
    const saved = h.rows.get('s')!;
    // The cancelled event used sequence 26. Its tombstone keeps sequence allocation
    // monotonic, while only 25 retained rows are available to page and export.
    h.rows.set('s', { ...saved, revision: saved.revision + 1, lastSequence: 26, messageCount: 25 });
    const recent = (await h.store.getRecent('s'))!;
    expect(recent.messages.map((message) => message.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => `m${index + 5}`),
    );
    expect((await h.store.getCompleteByPages('s'))?.messages.map((message) => message.id)).toEqual(
      Array.from({ length: 25 }, (_, index) => `m${index}`),
    );
  });

  it('allows anonymous empty initialization but rejects a real message without any local fallback', async () => {
    const h = harness();
    h.switchAccount(null);
    expect(await h.store.list()).toEqual([]);
    expect(await h.store.get('s')).toBeNull();
    const session = snapshot();
    await h.store.save(session);
    session.messages.push({ id: 'm', role: 'user', content: 'secret', createdAt: 1 });
    await expect(h.store.save(session)).rejects.toMatchObject({ status: 401 });
    expect(h.request).not.toHaveBeenCalled();
  });

  it('serializes streamed saves and propagates revision through runtime object spreads', async () => {
    const h = harness();
    const session = snapshot();
    await h.store.save(session);
    session.messages.push({ id: 'a', role: 'assistant', content: 'one', createdAt: 1 });
    const first = h.store.save(session);
    const next = { ...session, messages: [{ ...session.messages[0]!, content: 'one two' }] };
    await Promise.all([first, h.store.save(next)]);
    expect(h.rows.get('s')?.revision).toBe(3);
    expect(h.rows.get('s')?.session?.messages[0]?.content).toBe('one two');
    expect(h.request.mock.calls[0]?.[1]?.headers).toMatchObject({ 'x-account-id': 'alice' });
    expect(
      h.request.mock.calls.some(
        ([url, init]) => init?.method === 'POST' && String(url).endsWith('/messages'),
      ),
    ).toBe(true);
    expect(h.request.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
  });

  it('sends only new text messages through the incremental endpoint', async () => {
    const h = harness();
    const session = snapshot();
    await h.store.save(session);
    session.messages.push({ id: 'first', role: 'user', content: '你好', createdAt: 2 });
    await h.store.save(session);
    session.messages.push({ id: 'second', role: 'assistant', content: '你好呀', createdAt: 3 });
    await h.store.save(session);
    const appends = h.request.mock.calls.filter(
      ([url, init]) => init?.method === 'POST' && String(url).endsWith('/messages'),
    );
    expect(appends).toHaveLength(2);
    expect(JSON.parse(String(appends[1]?.[1]?.body)).messages).toEqual([
      { id: 'second', role: 'assistant', content: '你好呀', createdAt: 3 },
    ]);
    expect(h.request.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
    expect(h.rows.get('s')?.session?.messages.map((item) => item.id)).toEqual(['first', 'second']);
  });
  it('keeps device-only changes local without rewriting a long public transcript', async () => {
    const h = harness();
    const session = snapshot();
    session.messages = Array.from({ length: 25 }, (_, index) => ({
      id: `m${index}`,
      role: 'user' as const,
      content: `消息 ${index}`,
      createdAt: index,
    }));
    await h.store.save(session);
    const writes = h.request.mock.calls.length;
    session.deviceState = { ...session.deviceState };
    session.updatedAt = Date.now();
    await h.store.save(session);
    expect(h.request.mock.calls).toHaveLength(writes);
    expect(h.rows.get('s')?.revision).toBe(1);
  });
  it('updates title and scene through metadata-only requests', async () => {
    const h = harness();
    const session = snapshot();
    session.metadata = { promptPresetId: 'character', sceneId: 'market-cafe' };
    session.messages = [{ id: 'old', role: 'user', content: '很久以前', createdAt: 1 }];
    await h.store.save(session);
    session.metadata = { ...session.metadata, sessionTitle: '新标题', sceneId: 'market-park' };
    await h.store.save(session);
    const patch = h.request.mock.calls.find(([url]) => String(url).endsWith('/metadata'));
    expect(JSON.parse(String(patch?.[1]?.body)).changes).toEqual({
      sessionTitle: '新标题',
      sceneId: 'market-park',
    });
    expect(
      h.request.mock.calls.filter(
        ([url, init]) => init?.method === 'PUT' && !String(url).endsWith('/metadata'),
      ),
    ).toHaveLength(1);
    expect(h.rows.get('s')?.session?.messages).toHaveLength(1);
  });

  it('rebases verified concurrent append-only messages without dropping either device turn', async () => {
    const h = harness();
    await h.store.save(snapshot());
    const first = (await h.store.get('s'))!;
    const stale = (await h.store.get('s'))!;
    first.messages.push({ id: 'a', role: 'user', content: 'first', createdAt: 2 });
    await h.store.save(first);
    stale.messages.push({ id: 'b', role: 'user', content: 'stale', createdAt: 2 });
    await h.store.save(stale);
    expect(h.rows.get('s')?.session?.messages.map((message) => message.id)).toEqual(['a', 'b']);
    expect(stale.messages.map((message) => message.id)).toEqual(['a', 'b']);
    stale.messages.push({ id: 'reply', role: 'assistant', content: 'response', createdAt: 3 });
    await h.store.save(stale);
    expect(h.rows.get('s')?.session?.messages.map((message) => message.id)).toEqual([
      'a',
      'b',
      'reply',
    ]);
  });

  it('does not rebase when another device changes the scene or rewrites history', async () => {
    const h = harness();
    await h.store.save(snapshot());
    const local = (await h.store.get('s'))!;
    const remote = (await h.store.get('s'))!;
    remote.metadata = { sceneId: 'other' };
    await h.store.save(remote);
    local.messages.push({ id: 'new', role: 'user', content: 'hello', createdAt: 2 });
    await expect(h.store.save(local)).rejects.toMatchObject({ status: 409 });
    expect(h.rows.get('s')?.session?.messages).toEqual([]);

    const fresh = (await h.store.get('s'))!;
    const stale = (await h.store.get('s'))!;
    fresh.messages.push({ id: 'old', role: 'user', content: 'before', createdAt: 2 });
    await h.store.save(fresh);
    stale.messages.push({ id: 'later', role: 'assistant', content: 'reply', createdAt: 3 });
    await h.store.save(stale);
    const rewritten = (await h.store.get('s'))!;
    rewritten.messages[0]!.content = 'changed';
    await h.store.save(rewritten);
    stale.messages.push({ id: 'after', role: 'user', content: 'new', createdAt: 4 });
    await expect(h.store.save(stale)).rejects.toMatchObject({ status: 409 });
    expect(h.rows.get('s')?.session?.messages.map((message) => message.content)).toEqual([
      'changed',
      'reply',
    ]);
  });

  it('rejects a concurrent tail beyond the verifiable recent window', async () => {
    const h = harness();
    const original = snapshot();
    original.messages.push({ id: 'anchor', role: 'user', content: 'question', createdAt: 1 });
    await h.store.save(original);
    const stale = (await h.store.get('s'))!;
    const row = h.rows.get('s')!;
    const remote = Array.from({ length: 21 }, (_, index) => ({
      id: `remote-${index}`,
      role: 'user' as const,
      content: `text ${index}`,
      createdAt: index + 2,
    }));
    h.rows.set('s', {
      ...row,
      revision: row.revision + 1,
      lastSequence: 22,
      messageCount: 22,
      session: { ...row.session!, messages: [...row.session!.messages, ...remote] },
    });
    stale.messages.push({ id: 'reply', role: 'assistant', content: 'answer', createdAt: 100 });
    await expect(h.store.save(stale)).rejects.toMatchObject({ status: 409 });
    expect(h.rows.get('s')?.session?.messages.at(-1)?.id).toBe('remote-20');
  });

  it('blocks old-account writes and delayed reads after an account switch', async () => {
    const h = harness();
    await h.store.save(snapshot());
    const old = (await h.store.get('s'))!;
    h.switchAccount('bob');
    expect(() => h.store.save(old)).toThrow('账户已变化');
    let resolve!: (response: Response) => void;
    h.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const read = h.store.get('s');
    h.switchAccount('alice');
    resolve(Response.json(h.rows.get('s')));
    await expect(read).rejects.toMatchObject({ status: 403 });
  });

  it('does not upload device state, permissions, reasoning or tool payloads, and fails visibly offline', async () => {
    const h = harness();
    const session = snapshot();
    session.metadata = {
      sessionTitle: 'title',
      promptPresetId: 'gentle',
      sceneId: 'market-forest',
      permission: 'granted',
    };
    session.messages = [
      { id: 'm', role: 'assistant', content: 'hi', createdAt: 1, reasoningContent: 'private' },
    ];
    await h.store.save(session);
    const remote = h.rows.get('s')?.session;
    expect(remote).not.toHaveProperty('deviceState');
    expect(remote?.metadata).toEqual({
      sessionTitle: 'title',
      promptPresetId: 'gentle',
      sceneId: 'market-forest',
    });
    expect(remote?.messages[0]).not.toHaveProperty('reasoningContent');
    h.request.mockRejectedValueOnce(new Error('offline'));
    await expect(h.store.list()).rejects.toThrow('offline');
    expect(toServerSession(session)).toEqual(remote);
    session.metadata.sceneId = '';
    expect(toServerSession(session).metadata).toMatchObject({
      promptPresetId: 'gentle',
      sceneId: '',
    });
  });

  it('hides tombstones and sorts server pages newest-first', async () => {
    const h = harness();
    await h.store.save(snapshot('a'));
    await h.store.save({ ...snapshot('b'), updatedAt: 2 });
    expect((await h.store.list()).map((s) => s.id)).toEqual(['b', 'a']);
    await h.store.delete('b');
    expect(await h.store.get('b')).toBeNull();
    expect((await h.store.list()).map((s) => s.id)).toEqual(['a']);
  });
});

it('keeps valid in-flight versions across an unchanged account refresh', async () => {
  const h = harness();
  const row = snapshot();
  await h.store.save(row);
  h.switchAccount('alice');
  row.messages.push({ id: 'a', role: 'user', content: 'still here', createdAt: 1 });
  await h.store.save(row);
  expect(h.rows.get('s')?.revision).toBe(2);
});
it('deduplicates IDs updated between pagination pages and honors the newest tombstone', async () => {
  const h = harness();
  h.request.mockResolvedValueOnce(
    Response.json({
      items: [
        {
          id: 's',
          session: toServerSession(snapshot()),
          revision: 1,
          updatedAt: 1,
          deleted: false,
        },
      ],
      nextCursor: 'page2',
    }),
  );
  h.request.mockResolvedValueOnce(
    Response.json({
      items: [{ id: 's', session: null, revision: 2, updatedAt: 2, deleted: true }],
      nextCursor: null,
    }),
  );
  expect(await h.store.list()).toEqual([]);
});

it('calls the browser fetch with its own receiver when no request function is injected', async () => {
  // Chrome throws "Illegal invocation" when fetch runs with another object as `this`.
  const browserFetch = vi.fn(function (this: unknown) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    return Promise.resolve(Response.json({ items: [], nextCursor: null }));
  });
  vi.stubGlobal('fetch', browserFetch);
  try {
    const store = new ServerSessionStore({
      migrateLegacy: false,
      accountId: () => 'alice',
      subscribeAccount: () => () => {},
    });
    await store.list();
    expect(browserFetch).toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
