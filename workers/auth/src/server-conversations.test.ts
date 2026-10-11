import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { handleServerConversations } from './server-conversations';
import { createTestDb } from './test-helpers';
import { sha256Hex, type SessionEnv } from './session-domain';
let db: ReturnType<typeof createTestDb>;
let env: SessionEnv;
beforeEach(async () => {
  db = createTestDb();
  env = { DB: db.DB } as SessionEnv;
  for (const id of ['alice', 'bob']) {
    await env.DB.prepare(
      'INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES (?,?,?,?,1)',
    )
      .bind(id, id, id, 'unused')
      .run();
    await env.DB.prepare(
      'INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES (?,?,1,?)',
    )
      .bind(await sha256Hex(id), id, Date.now() + 60_000)
      .run();
  }
});
afterEach(() => db.close());
async function call(path = '', method = 'GET', body?: unknown, user = 'alice', account = user) {
  return (await handleServerConversations(
    new Request(`https://test/api/auth/conversations${path}`, {
      method,
      headers: { Authorization: `Bearer ${user}`, 'X-Account-Id': account },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
    {},
  ))!;
}
const message = (id: string, content = 'hello', role = 'user') => ({
  id,
  role,
  content,
  createdAt: 1,
});
const snapshot = (
  id = 's',
  messages: Array<ReturnType<typeof message> & { kind?: 'camera_observation' }> = [message('m')],
) => ({
  id,
  createdAt: 1,
  updatedAt: 1,
  messages,
  deviceState: { connected: true },
  metadata: {
    sessionTitle: 'title',
    sensorTriggersEnabled: true,
    permission: 'allow',
    promptPresetId: 'builtin:friend',
  },
});
const put = (session = snapshot(), expectedRevision = 0) =>
  call(`/${session.id}`, 'PUT', { session, expectedRevision });

describe('server conversations', () => {
  it('queues opted-in private memory after both full and incremental user writes, but not retries or opt-out', async () => {
    await env.DB.prepare(
      `INSERT INTO character_relationships(user_id,id,character_id,ai_nickname,user_preferred_name,
       relationship_type,notes,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,1,1)`,
    )
      .bind('alice', 'rel', 'character', '', '', '', '')
      .run();
    await env.DB.prepare(
      `INSERT INTO relationship_memory_preferences(user_id,relationship_id,enabled,version,updated_at)
       VALUES('alice','rel',1,1,1)`,
    ).run();
    const session = snapshot('memo', [message('first', '请记得我喜欢乌龙茶')]);
    session.metadata.promptPresetId = 'character';
    const bound = { ...session, metadata: { ...session.metadata, relationshipId: 'rel' } };
    expect((await put(bound)).status).toBe(201);
    const job = () =>
      env.DB.prepare(
        `SELECT generation FROM memory_extraction_jobs WHERE user_id='alice' AND conversation_id='memo'`,
      ).first<{ generation: number }>();
    expect(await job()).toEqual({ generation: 1 });

    const addition = { expectedRevision: 1, messages: [message('second', '今天也想和你聊天')] };
    expect((await call('/memo/messages', 'POST', addition)).status).toBe(200);
    expect(await job()).toEqual({ generation: 2 });
    expect((await call('/memo/messages', 'POST', addition)).status).toBe(200);
    expect(await job()).toEqual({ generation: 2 });
    expect(
      (
        await call('/memo/messages', 'POST', {
          expectedRevision: 2,
          messages: [message('reply', '你好呀', 'assistant')],
        })
      ).status,
    ).toBe(200);
    expect(await job()).toEqual({ generation: 2 });

    await env.DB.prepare(
      `UPDATE relationship_memory_preferences SET enabled=0,version=2 WHERE user_id='alice' AND relationship_id='rel'`,
    ).run();
    expect(
      (
        await call('/memo/messages', 'POST', {
          expectedRevision: 3,
          messages: [message('third', '这条不要自动提取')],
        })
      ).status,
    ).toBe(200);
    expect(await job()).toEqual({ generation: 2 });
  });
  it('searches only the signed-in account’s live transcript and title with literal wildcards', async () => {
    await put(snapshot('first', [message('m1', 'Remember blue_fox')]));
    await put(snapshot('second', [message('m2', 'Remember blueXfox')]));
    await call('/first', 'DELETE', { expectedRevision: 1 });
    await put(snapshot('third', [message('m3', 'Remember blue_fox')]), 0);
    await put(snapshot('other', [message('m4', 'Remember blue_fox')]), 0);
    const own = await call('/search?q=blue_fox');
    expect(own.status).toBe(200);
    expect(own.headers.get('Cache-Control')).toBe('no-store');
    expect(await own.json()).toEqual({ ids: ['other', 'third'] });
    expect(
      ((await (await call('/search?q=title')).json()) as { ids: string[] }).ids.sort(),
    ).toEqual(['other', 'second', 'third']);
    expect(await (await call('/search?q=blue_fox', 'GET', undefined, 'bob')).json()).toEqual({
      ids: [],
    });
    expect((await call('/search?q=x')).status).toBe(400);
    expect((await call('/search?q=blue_fox', 'GET', undefined, 'alice', 'bob')).status).toBe(403);
  });
  it('reads owned message history by stable server sequence without loading the full transcript', async () => {
    await put(snapshot('s', [message('one'), message('two'), message('three'), message('four')]));
    const first = await call('/s/messages?limit=2');
    expect(first.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toBe('no-store');
    const page = (await first.json()) as {
      items: Array<{ id: string; sequence: number }>;
      nextBefore: number;
    };
    expect(page.items.map((item) => item.id)).toEqual(['three', 'four']);
    expect(page.items.map((item) => item.sequence)).toEqual([3, 4]);
    expect(page.nextBefore).toBe(3);
    expect(
      await (await call(`/s/messages?limit=2&before=${page.nextBefore}`)).json(),
    ).toMatchObject({
      items: [
        { id: 'one', sequence: 1 },
        { id: 'two', sequence: 2 },
      ],
      nextBefore: null,
    });
    expect((await call('/s/messages?limit=21')).status).toBe(400);
    expect((await call('/s/messages?before=invalid')).status).toBe(400);
    expect((await call('/s/messages', 'GET', undefined, 'bob')).status).toBe(404);
    expect((await call('/s/messages', 'GET', undefined, 'alice', 'bob')).status).toBe(403);
    expect((await call('/s/messages', 'POST', {})).status).toBe(400);
    expect((await call('/s/messages', 'DELETE')).status).toBe(405);
    expect((await call('/s', 'DELETE', { expectedRevision: 1 })).status).toBe(200);
    expect((await call('/s/messages')).status).toBe(404);
  });
  it('returns only the latest twenty messages for media context while keeping older messages on the server', async () => {
    await put(
      snapshot(
        's',
        Array.from({ length: 25 }, (_, index) => message(`m${index}`)),
      ),
    );
    const window = (await (await call('/s?window=20')).json()) as {
      session: { messages: Array<{ id: string }> };
    };
    expect(window.session.messages.map((item) => item.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => `m${index + 5}`),
    );
    expect(((await (await call('/s')).json()) as typeof window).session.messages).toHaveLength(25);
    const observation = await call('/s/observations?window=20', 'POST', {
      id: 'camera-new',
      content: '窗边有一棵树',
    });
    expect(observation.status).toBe(200);
    expect(((await observation.json()) as typeof window).session.messages).toHaveLength(20);
    expect(
      (
        (await (await call('/s/messages?limit=20')).json()) as {
          items: Array<{ id: string }>;
        }
      ).items.at(-1)?.id,
    ).toBe('camera-new');
  });
  it('reports retained message count after a cancelled terminal camera event without reusing its sequence', async () => {
    await put(
      snapshot(
        's',
        Array.from({ length: 25 }, (_, index) => message(`m${index}`)),
      ),
    );
    const posted = await call('/s/observations', 'POST', {
      id: 'camera-cancelled',
      content: '画面已过时',
    });
    expect(posted.status).toBe(200);
    const before = (await posted.json()) as {
      revision: number;
      lastSequence: number;
      messageCount: number;
    };
    expect(before).toMatchObject({ lastSequence: 26, messageCount: 26 });
    expect((await call('/s/observations', 'DELETE', { id: 'camera-cancelled' })).status).toBe(200);
    const restored = (await (await call('/s?window=20')).json()) as {
      revision: number;
      lastSequence: number;
      messageCount: number;
      session: { messages: Array<{ id: string }> };
    };
    expect(restored).toMatchObject({
      revision: before.revision + 1,
      lastSequence: 26,
      messageCount: 25,
    });
    expect(restored.session.messages.at(-1)?.id).toBe('m24');
    const page = (await (await call('/s/messages?limit=20')).json()) as {
      revision: number;
      lastSequence: number;
      messageCount: number;
      items: Array<{ id: string; sequence: number }>;
    };
    expect(page).toMatchObject({
      revision: restored.revision,
      lastSequence: 26,
      messageCount: 25,
    });
    expect(page.items.at(-1)).toMatchObject({ id: 'm24', sequence: 25 });
    expect(
      (
        await call('/s/observations', 'POST', {
          id: 'camera-cancelled',
          content: '画面已过时',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call('/s/messages', 'POST', {
          expectedRevision: restored.revision,
          messages: [message('after', '继续聊天')],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        (await (await call('/s/messages?limit=1')).json()) as {
          items: Array<{ id: string; sequence: number }>;
        }
      ).items,
    ).toMatchObject([{ id: 'after', sequence: 27 }]);
  });
  it('binds an owned character relationship without rewriting messages or the active scene', async () => {
    await env.DB.prepare(
      `INSERT INTO character_relationships
       (user_id,id,character_id,ai_nickname,user_preferred_name,relationship_type,notes,version,created_at,updated_at)
       VALUES('alice','r','builtin:friend','','','','',1,1,1)`,
    ).run();
    await put(snapshot('s', [message('old')]));
    expect(
      (
        await call('/s/relationship', 'PUT', {
          expectedRevision: 1,
          relationshipId: 'other',
        })
      ).status,
    ).toBe(409);
    const response = await call('/s/relationship', 'PUT', {
      expectedRevision: 1,
      relationshipId: 'r',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      revision: 2,
      session: { metadata: { relationshipId: 'r' }, messages: [{ id: 'old' }] },
    });
    expect(
      (
        await call('/s/relationship', 'PUT', {
          expectedRevision: 1,
          relationshipId: 'r',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call(
          '/s/relationship',
          'PUT',
          {
            expectedRevision: 2,
            relationshipId: 'r',
          },
          'bob',
        )
      ).status,
    ).toBe(404);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM server_conversation_messages WHERE user_id='alice' AND conversation_id='s'",
      ).first(),
    ).toEqual({ n: 1 });
  });
  it('updates only title and scene metadata by revision without resending messages', async () => {
    await put(snapshot('s', [message('old')]));
    expect(
      (
        await call('/s/metadata', 'PUT', {
          expectedRevision: 1,
          changes: { promptPresetId: 'other' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('/s/metadata', 'PUT', {
          expectedRevision: 1,
          changes: { permission: 'allow' },
        })
      ).status,
    ).toBe(400);
    const changed = await call('/s/metadata', 'PUT', {
      expectedRevision: 1,
      changes: { sessionTitle: '新标题', sceneId: 'market-park' },
    });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({
      revision: 2,
      metadata: {
        sessionTitle: '新标题',
        sceneId: 'market-park',
        promptPresetId: 'builtin:friend',
      },
    });
    expect(
      (
        await call('/s/metadata', 'PUT', {
          expectedRevision: 1,
          changes: { sessionTitle: '新标题' },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call('/s/metadata', 'PUT', {
          expectedRevision: 1,
          changes: { sceneId: 'market-other' },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call('/s/metadata', 'PUT', {
          expectedRevision: 2,
          changes: { sessionTitle: null, sceneId: null },
        })
      ).status,
    ).toBe(200);
    expect(await (await call('/s?window=20')).json()).toMatchObject({
      session: { metadata: { sceneId: '', promptPresetId: 'builtin:friend' } },
    });
    expect(
      (
        await call(
          '/s/metadata',
          'PUT',
          {
            expectedRevision: 3,
            changes: { sessionTitle: 'bob' },
          },
          'bob',
        )
      ).status,
    ).toBe(404);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM server_conversation_messages WHERE user_id='alice' AND conversation_id='s'",
      ).first(),
    ).toEqual({ n: 1 });
  });
  it('appends bounded messages without reposting history, rejects conflicting IDs and deduplicates retries', async () => {
    await put(snapshot('s', [message('old')]));
    const batch = { expectedRevision: 1, messages: [message('new-1'), message('new-2')] };
    expect(await (await call('/s/messages', 'POST', batch)).json()).toMatchObject({
      revision: 2,
      lastSequence: 3,
      added: 2,
    });
    expect(await (await call('/s/messages?limit=3')).json()).toMatchObject({
      items: [
        { id: 'old', sequence: 1 },
        { id: 'new-1', sequence: 2 },
        { id: 'new-2', sequence: 3 },
      ],
    });
    expect(
      (
        await env.DB.prepare(
          "SELECT id,position FROM server_conversation_messages WHERE user_id='alice' AND conversation_id='s' ORDER BY position",
        ).all()
      ).results,
    ).toEqual([
      { id: 'old', position: 0 },
      { id: 'new-1', position: 1 },
      { id: 'new-2', position: 2 },
    ]);
    expect(await (await call('/s/messages', 'POST', batch)).json()).toMatchObject({
      revision: 2,
      added: 0,
    });
    expect(
      (
        await call('/s/messages', 'POST', {
          expectedRevision: 2,
          messages: [message('new-1', 'changed')],
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call('/s/messages', 'POST', {
          expectedRevision: 1,
          messages: [message('new-3')],
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call('/s/messages', 'POST', {
          expectedRevision: 2,
          messages: [{ ...message('forged'), kind: 'camera_observation' }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          '/s/messages',
          'POST',
          {
            expectedRevision: 2,
            messages: [message('new-4')],
          },
          'bob',
        )
      ).status,
    ).toBe(404);
  });
  it('appends after the stored transcript exceeds the legacy two-megabyte PUT limit', async () => {
    await put(snapshot('s', []));
    await env.DB.batch(
      Array.from({ length: 21 }, (_, index) =>
        env.DB.prepare(
          `INSERT INTO server_conversation_messages
         (user_id,conversation_id,id,role,content,created_at,position)
         VALUES('alice','s',?,'user',?,1,?)`,
        ).bind(`large-${index}`, '长'.repeat(100_000), index),
      ),
    );
    const saved = await call('/s/messages', 'POST', {
      expectedRevision: 1,
      messages: [message('after-large', '继续聊天')],
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ revision: 2, lastSequence: 22, added: 1 });
    expect(await (await call('/s/messages?limit=1')).json()).toMatchObject({
      items: [{ id: 'after-large', content: '继续聊天', sequence: 22 }],
    });
    expect(
      (
        await call('/s/messages', 'POST', {
          expectedRevision: 2,
          messages: [message('reply-large', '收', 'assistant')],
        })
      ).status,
    ).toBe(200);
    expect(
      await (
        await call('/s/messages', 'POST', {
          expectedRevision: 3,
          messages: [message('reply-large', '收到', 'assistant')],
        })
      ).json(),
    ).toMatchObject({ revision: 4, lastSequence: 23, added: 0, extended: 1 });
    const renamed = await call('/s/metadata', 'PUT', {
      expectedRevision: 4,
      changes: { sessionTitle: '长聊天' },
    });
    expect(renamed.status).toBe(200);
    expect((await renamed.text()).length).toBeLessThan(500);
  });
  it('allows only one concurrent incremental writer for the same revision', async () => {
    await put(snapshot('s', []));
    const responses = await Promise.all([
      call('/s/messages', 'POST', { expectedRevision: 1, messages: [message('first')] }),
      call('/s/messages', 'POST', { expectedRevision: 1, messages: [message('second')] }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const page = (await (await call('/s/messages')).json()) as { items: unknown[] };
    expect(page.items).toHaveLength(1);
  });
  it('extends only an existing assistant message prefix without changing its sequence', async () => {
    await put(snapshot('s', [message('user', '你好'), message('reply', '你', 'assistant')]));
    const extended = { ...message('reply', '你好呀', 'assistant') };
    expect(
      await (
        await call('/s/messages', 'POST', {
          expectedRevision: 1,
          messages: [extended],
        })
      ).json(),
    ).toMatchObject({ revision: 2, lastSequence: 2, added: 0, extended: 1 });
    expect(
      await (
        await call('/s/messages', 'POST', {
          expectedRevision: 1,
          messages: [extended],
        })
      ).json(),
    ).toMatchObject({ revision: 2, added: 0, extended: 0 });
    expect(
      (
        await call('/s/messages', 'POST', {
          expectedRevision: 2,
          messages: [message('reply', '你', 'assistant')],
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call('/s/messages', 'POST', {
          expectedRevision: 2,
          messages: [message('user', '你好呀')],
        })
      ).status,
    ).toBe(409);
    expect(await (await call('/s/messages')).json()).toMatchObject({
      items: [
        { id: 'user', sequence: 1 },
        { id: 'reply', sequence: 2, content: '你好呀' },
      ],
    });
  });
  it('stores camera observations as typed immutable events without accepting generic forged kinds', async () => {
    expect(
      (
        await put(
          snapshot('s', [{ ...message('fake', 'fake', 'assistant'), kind: 'camera_observation' }]),
        )
      ).status,
    ).toBe(400);
    expect((await put(snapshot('s', []))).status).toBe(201);
    const observation = { id: 'camera-one', content: '画面中有一张桌子' };
    const saved = await call('/s/observations', 'POST', observation);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      session: {
        messages: [
          {
            id: 'camera-one',
            role: 'assistant',
            kind: 'camera_observation',
            content: observation.content,
          },
        ],
      },
    });
    expect((await call('/s/observations', 'POST', observation)).status).toBe(200);
    expect(
      (await call('/s/observations', 'POST', { ...observation, content: 'changed' })).status,
    ).toBe(409);
    const row = (await (await call('/s')).json()) as {
      revision: number;
      session: { messages: ReturnType<typeof message>[] };
    };
    expect(row.session.messages).toHaveLength(1);
    const legacyEcho = {
      ...message('camera-one', observation.content, 'assistant'),
      createdAt: row.session.messages[0]!.createdAt,
    };
    expect((await put(snapshot('s', [legacyEcho]), row.revision)).status).toBe(200);
    expect((await (await call('/s')).json()) as unknown).toMatchObject({
      session: { messages: [{ id: 'camera-one', kind: 'camera_observation' }] },
    });
    expect(
      (
        await put(
          snapshot('s', [{ ...legacyEcho, content: 'changed', kind: 'camera_observation' }]),
          row.revision + 1,
        )
      ).status,
    ).toBe(409);
    expect((await put(snapshot('s', [message('ordinary', 'hi')]), row.revision + 1)).status).toBe(
      200,
    );
    expect((await call('/s/observations', 'POST', { id: 'ordinary', content: 'hi' })).status).toBe(
      409,
    );
    expect((await call('/s/observations', 'POST', observation, 'bob')).status).toBe(404);
    const latest = (await (await call('/s')).json()) as { revision: number };
    expect((await call('/s', 'DELETE', { expectedRevision: latest.revision })).status).toBe(200);
    expect((await call('/s/observations', 'POST', observation)).status).toBe(404);
    expect(
      (await call('/s/observations', 'POST', { id: 'camera-two', content: 'after deletion' }))
        .status,
    ).toBe(404);
  });
  it('deduplicates concurrent observation submissions without double sequence or revision', async () => {
    await put(snapshot('s', []));
    const [first, second] = await Promise.all([
      call('/s/observations', 'POST', { id: 'camera-once', content: '同一画面' }),
      call('/s/observations', 'POST', { id: 'camera-once', content: '同一画面' }),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    const saved = (await (await call('/s')).json()) as {
      revision: number;
      lastSequence: number;
      session: { messages: unknown[] };
    };
    expect(saved.revision).toBe(2);
    expect(saved.lastSequence).toBe(1);
    expect(saved.session.messages).toHaveLength(1);
  });
  it('retracts an in-flight observation in either request order and blocks later retries', async () => {
    await put(snapshot('s', []));
    const first = { id: 'camera-before', content: '先发观察' };
    expect((await call('/s/observations', 'DELETE', { id: first.id })).status).toBe(200);
    expect((await call('/s/observations', 'POST', first)).status).toBe(409);
    expect((await call('/s/observations', 'POST', first)).status).toBe(409);
    const second = { id: 'camera-after', content: '后撤销观察' };
    expect((await call('/s/observations', 'POST', second)).status).toBe(200);
    expect((await call('/s/observations', 'DELETE', { id: second.id })).status).toBe(200);
    expect((await call('/s/observations', 'DELETE', { id: second.id })).status).toBe(200);
    expect((await call('/s/observations', 'POST', second)).status).toBe(409);
    expect(((await (await call('/s/messages')).json()) as { items: unknown[] }).items).toEqual([]);
    expect((await call('/s/observations', 'DELETE', { id: second.id }, 'bob')).status).toBe(404);
    expect(
      (await call('/s/observations', 'DELETE', { id: second.id }, 'alice', 'bob')).status,
    ).toBe(403);
    expect(
      (await call('/s/observations', 'DELETE', { id: second.id, content: second.content })).status,
    ).toBe(400);
    expect(
      (
        await put(
          snapshot('s', [
            { ...message(second.id, second.content, 'assistant'), kind: 'camera_observation' },
          ]),
          3,
        )
      ).status,
    ).toBe(400);
  });
  it('isolates accounts, checks pinned account and strips local execution metadata', async () => {
    expect((await call('', 'GET', undefined, 'missing')).status).toBe(401);
    expect((await call('', 'GET', undefined, 'alice', 'bob')).status).toBe(403);
    const saved = await put();
    expect(saved.status).toBe(201);
    expect(saved.headers.get('cache-control')).toBe('no-store');
    const item = (await saved.json()) as { session: Record<string, unknown> };
    expect(item.session.deviceState).toBeUndefined();
    expect(item.session.metadata).toEqual({
      sessionTitle: 'title',
      promptPresetId: 'builtin:friend',
    });
    expect((await call('/s', 'GET', undefined, 'bob')).status).toBe(404);
    expect(await (await call('', 'GET', undefined, 'bob')).json()).toMatchObject({ items: [] });
  });
  it('merges by message ID, preserves omitted messages and permits explicit assistant append only', async () => {
    await put(snapshot('s', [message('u'), message('a', 'hi', 'assistant')]));
    expect((await put(snapshot('s', [message('a', 'hi there', 'assistant')]), 1)).status).toBe(200);
    expect(await (await call('/s')).json()).toMatchObject({
      revision: 2,
      session: { messages: [message('u'), message('a', 'hi there', 'assistant')] },
    });
    expect((await put(snapshot('s', [message('u', 'rewritten')]), 2)).status).toBe(409);
    expect((await put(snapshot('s', [message('a', 'hi', 'assistant')]), 2)).status).toBe(409);
    expect((await put(snapshot(), 1)).status).toBe(409);
  });
  it('allows only one concurrent CAS writer and never resurrects deleted records', async () => {
    await put();
    const results = await Promise.all([
      put(snapshot('s', [message('x')]), 1),
      put(snapshot('s', [message('y')]), 1),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const stored = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM server_conversation_messages WHERE user_id=? AND conversation_id=?',
    )
      .bind('alice', 's')
      .first();
    expect(stored).toEqual({ n: 2 });
    expect((await call('/s', 'DELETE', { expectedRevision: 1 })).status).toBe(409);
    expect((await call('/s', 'DELETE', { expectedRevision: 2 })).status).toBe(200);
    expect((await call('/s')).status).toBe(410);
    expect((await put()).status).toBe(409);
    expect((await put(snapshot(), 3)).status).toBe(409);
    expect(
      await env.DB.prepare(
        'SELECT COUNT(*) AS n FROM server_conversation_messages WHERE user_id=? AND conversation_id=?',
      )
        .bind('alice', 's')
        .first(),
    ).toEqual({ n: 0 });
  });
  it('paginates same-millisecond legacy imports without omissions and retains the old rows', async () => {
    for (const id of ['a', 'b', 'c'])
      await env.DB.prepare(
        'INSERT INTO agent_sessions(user_id,id,payload,client_updated_at,updated_at) VALUES (?,?,?,?,?)',
      )
        .bind('alice', id, JSON.stringify(snapshot(id)), 1, 100)
        .run();
    const first = (await (await call('?limit=2')).json()) as {
      items: { id: string }[];
      nextCursor: string;
    };
    expect(first.items.map((x) => x.id)).toEqual(['a', 'b']);
    const second = (await (
      await call(`?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)
    ).json()) as { items: { id: string }[]; nextCursor: null };
    expect(second.items.map((x) => x.id)).toEqual(['c']);
    expect(second.nextCursor).toBeNull();
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM agent_sessions').first()).toEqual({
      n: 3,
    });
    expect((await put(snapshot('a', [message('new')]), 1)).status).toBe(200);
    await call();
    expect(await (await call('/a')).json()).toMatchObject({
      revision: 2,
      session: { messages: [message('m'), message('new')] },
    });
  });
  it('rolls back the entire CAS transaction when a message insert fails', async () => {
    await put();
    await env.DB.prepare(
      `CREATE TRIGGER reject_message BEFORE INSERT ON server_conversation_messages
      WHEN NEW.content = 'explode' BEGIN SELECT RAISE(ABORT, 'test failure'); END`,
    ).run();
    await expect(
      put(snapshot('s', [message('first'), message('second', 'explode')]), 1),
    ).rejects.toThrow('test failure');
    expect(await (await call('/s')).json()).toMatchObject({
      revision: 1,
      session: { messages: [message('m')] },
    });
  });

  it('writes only appended or changed messages and accepts encoded legacy IDs', async () => {
    await put(snapshot('old:session'));
    await env.DB.prepare(
      `CREATE TRIGGER reject_unchanged BEFORE UPDATE OF content ON server_conversation_messages
      WHEN NEW.content = OLD.content BEGIN SELECT RAISE(ABORT, 'unnecessary rewrite'); END`,
    ).run();
    expect((await put(snapshot('old:session', [message('m'), message('next')]), 1)).status).toBe(
      200,
    );
    expect(await (await call('/old%3Asession')).json()).toMatchObject({
      revision: 2,
      session: { messages: [message('m'), message('next')] },
    });
  });

  it('keeps the character and relationship binding immutable on full saves', async () => {
    const relate = (id: string, character: string) =>
      env.DB.prepare(
        `INSERT INTO character_relationships(user_id,id,character_id,ai_nickname,user_preferred_name,relationship_type,notes,version,created_at,updated_at) VALUES ('alice',?,?,'','','','',1,1,1)`,
      )
        .bind(id, character)
        .run();
    await relate('rel-a', 'character-a');
    await relate('rel-b', 'character-b');
    const base = snapshot('bound');
    const session = {
      ...base,
      metadata: { ...base.metadata, promptPresetId: 'character-a' } as unknown as Record<
        string,
        string
      >,
    };
    const save = (metadata: Record<string, string>, revision = 0) =>
      put({ ...session, metadata } as unknown as ReturnType<typeof snapshot>, revision);
    // A relationship must belong to the conversation's character.
    expect((await save({ ...session.metadata, relationshipId: 'rel-b' })).status).toBe(400);
    expect((await save({ ...session.metadata, relationshipId: 'rel-a' })).status).toBe(201);
    // A stale client cannot rebind the history to a recreated relationship or another character.
    await env.DB.prepare(`UPDATE character_relationships SET deleted_at=2 WHERE id='rel-a'`).run();
    await relate('rel-a2', 'character-a');
    expect((await save({ ...session.metadata, relationshipId: 'rel-a2' }, 1)).status).toBe(409);
    expect((await save({ ...session.metadata, promptPresetId: 'character-b' }, 1)).status).toBe(
      409,
    );
    // Omitting the binding keeps it.
    const saved = await save(session.metadata, 1);
    expect(saved.status).toBe(200);
    expect(
      ((await saved.json()) as { session: { metadata: unknown } }).session.metadata,
    ).toMatchObject({
      promptPresetId: 'character-a',
      relationshipId: 'rel-a',
    });
  });
  it('rejects another account relationship reference and cascades account data', async () => {
    await env.DB.prepare(
      `INSERT INTO character_relationships(user_id,id,character_id,ai_nickname,user_preferred_name,relationship_type,notes,version,created_at,updated_at) VALUES ('bob','friend','builtin:friend','','','','',1,1,1)`,
    ).run();
    expect(
      (
        await call('/s', 'PUT', {
          expectedRevision: 0,
          session: { ...snapshot(), metadata: { relationshipId: 'friend' } },
        })
      ).status,
    ).toBe(400);
    await put();
    await env.DB.prepare('DELETE FROM users WHERE id=?').bind('alice').run();
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS n FROM server_conversation_messages').first(),
    ).toEqual({ n: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM server_conversations').first()).toEqual({
      n: 0,
    });
  });

  it('keeps a character relationship while changing or clearing an optional scene', async () => {
    await env.DB.prepare(
      `INSERT INTO character_relationships(user_id,id,character_id,ai_nickname,user_preferred_name,relationship_type,notes,version,created_at,updated_at) VALUES ('alice','friend','market-character','','','','',1,1,1)`,
    ).run();
    const character = {
      relationshipId: 'friend',
      promptPresetId: 'market-character',
    };
    const first = await call('/s', 'PUT', {
      expectedRevision: 0,
      session: { ...snapshot(), metadata: { ...character, sceneId: 'market-cafe' } },
    });
    expect(first.status).toBe(201);
    expect(await (await call('/s')).json()).toMatchObject({
      session: { metadata: { ...character, sceneId: 'market-cafe' } },
    });
    const changed = await call('/s', 'PUT', {
      expectedRevision: 1,
      session: { ...snapshot(), metadata: { sceneId: 'market-park' } },
    });
    expect(changed.status).toBe(200);
    expect(await (await call('/s')).json()).toMatchObject({
      session: { metadata: { ...character, sceneId: 'market-park' } },
    });
    const cleared = await call('/s', 'PUT', {
      expectedRevision: 2,
      session: { ...snapshot(), metadata: { sceneId: '' } },
    });
    expect(cleared.status).toBe(200);
    expect(await (await call('/s')).json()).toMatchObject({
      session: { metadata: { ...character, sceneId: '' } },
    });
  });

  it('reports a malformed legacy row without hiding valid sessions and does not reimport a deleted ID', async () => {
    await env.DB.prepare(
      'INSERT INTO agent_sessions(user_id,id,payload,client_updated_at,updated_at) VALUES (?,?,?,?,?)',
    )
      .bind('alice', 'broken', 'not json', 1, 1)
      .run();
    await put();
    expect(await (await call()).json()).toMatchObject({
      items: [{ id: 's' }],
      migrationErrors: [{ id: 'broken' }],
    });
    expect((await call('/broken')).status).toBe(422);
    await call('/s', 'DELETE', { expectedRevision: 1 });
    await env.DB.prepare(
      'INSERT INTO agent_sessions(user_id,id,payload,client_updated_at,updated_at) VALUES (?,?,?,?,?)',
    )
      .bind('alice', 's', JSON.stringify(snapshot()), 999, 999)
      .run();
    expect((await call('/s')).status).toBe(410);
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS n FROM server_conversation_messages').first(),
    ).toEqual({ n: 0 });
  });

  it('rejects malformed and duplicate messages and unknown fields', async () => {
    expect((await put(snapshot('s', [message('m'), message('m')]))).status).toBe(400);
    expect(
      (await call('/s', 'PUT', { session: snapshot(), expectedRevision: 0, userId: 'bob' })).status,
    ).toBe(400);
    expect((await call('?cursor=broken')).status).toBe(400);
    expect((await call('?limit=101')).status).toBe(400);
    expect((await call('/s', 'PUT', { session: snapshot() })).status).toBe(400);
  });
});

it('returns bounded summary pages without transcript or device state and preserves tombstones', async () => {
  await put(
    snapshot('a', [message('m1', 'secret body'), message('m2', 'z'.repeat(300), 'assistant')]),
  );
  await put(snapshot('b'));
  const response = await call('?summary=1&limit=1');
  const page = (await response.json()) as {
    items: Array<Record<string, unknown>>;
    nextCursor: string;
  };
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({
    id: 'a',
    preview: 'z'.repeat(160),
    metadata: { sessionTitle: 'title' },
  });
  expect(page.items[0]).not.toHaveProperty('session');
  expect(page.items[0]).not.toHaveProperty('messages');
  expect(JSON.stringify(page)).not.toContain('secret body');
  expect(
    (
      (await (await call(`?summary=1&cursor=${encodeURIComponent(page.nextCursor)}`)).json()) as {
        items: unknown[];
      }
    ).items,
  ).toHaveLength(1);
  await call('/a', 'DELETE', { expectedRevision: 1 });
  const deleted = (await (await call('?summary=1')).json()) as {
    items: Array<{ id: string; deleted: boolean; preview: string; metadata: unknown }>;
  };
  expect(deleted.items.find((row) => row.id === 'a')).toMatchObject({
    deleted: true,
    preview: '',
    metadata: {},
  });
  expect(await (await call('?summary=1', 'GET', undefined, 'bob')).json()).toMatchObject({
    items: [],
  });
});

it('allocates stable server sequences, excludes metadata changes and advances reads monotonically', async () => {
  await put(snapshot('s', [message('u'), message('a', 'hello', 'assistant')]));
  const summaries = async () =>
    (await (await call('?summary=1&order=recent')).json()) as {
      items: Array<{
        lastSequence: number;
        lastMessageAt: number | null;
        readSequence: number | null;
        unread: number | null;
      }>;
    };
  const first = (await summaries()).items[0]!;
  expect(first).toMatchObject({ lastSequence: 2, readSequence: null, unread: null });
  expect(await (await call('/s')).json()).toMatchObject({
    lastSequence: 2,
    session: { messages: [message('u'), message('a', 'hello', 'assistant')] },
  });
  expect(first.lastMessageAt).toBeGreaterThan(0);
  expect((await call('/s/read', 'PUT', { sequence: 2 }, 'bob')).status).toBe(409);
  expect((await call('/s/read', 'PUT', { sequence: 3 })).status).toBe(409);
  await call('/s/read', 'PUT', { sequence: 1 });
  expect((await summaries()).items[0]!.unread).toBe(1);
  await put(snapshot('s', [message('a', 'hello again', 'assistant')]), 1);
  expect((await summaries()).items[0]).toMatchObject({
    lastSequence: 2,
    lastMessageAt: first.lastMessageAt,
    unread: 1,
  });
  await Promise.all([
    call('/s/read', 'PUT', { sequence: 2 }),
    call('/s/read', 'PUT', { sequence: 0 }),
  ]);
  expect((await summaries()).items[0]).toMatchObject({ readSequence: 2, unread: 0 });
  await put(snapshot('s', [message('next', 'new', 'assistant')]), 2);
  expect((await summaries()).items[0]).toMatchObject({
    lastSequence: 3,
    readSequence: 2,
    unread: 1,
  });
  await call('/s', 'DELETE', { expectedRevision: 3 });
  expect((await call('/s/read', 'PUT', { sequence: 3 })).status).toBe(409);
  expect((await summaries()).items).toEqual([]);
});
it('paginates equal server timestamps without duplicates and never dates empty sessions', async () => {
  await put(snapshot('b', []));
  await put(snapshot('a', []));
  const one = (await (await call('?summary=1&order=recent&limit=1')).json()) as {
    items: Array<{ id: string; lastMessageAt: null }>;
    nextCursor: string;
  };
  expect(one.items[0]).toMatchObject({ id: 'a', lastMessageAt: null });
  const two = (await (
    await call('?summary=1&order=recent&limit=1&cursor=' + encodeURIComponent(one.nextCursor))
  ).json()) as { items: Array<{ id: string }>; nextCursor: null };
  expect(two.items[0]!.id).toBe('b');
  expect(two.nextCursor).toBeNull();
});

it('keeps lazy imported history unknown but dates subsequent direct message inserts', async () => {
  await env.DB.prepare(
    'INSERT INTO agent_sessions(user_id,id,payload,client_updated_at,updated_at) VALUES (?,?,?,?,?)',
  )
    .bind('alice', 'legacy', JSON.stringify(snapshot('legacy')), 1, 1)
    .run();
  expect(await (await call('?summary=1&order=recent')).json()).toMatchObject({
    items: [
      { id: 'legacy', lastSequence: 1, lastMessageAt: null, readSequence: null, unread: null },
    ],
  });
  await env.DB.prepare(
    "INSERT INTO server_conversation_messages(user_id,conversation_id,id,role,content,created_at,position) VALUES ('alice','legacy','scheduled','assistant','message',1,1)",
  ).run();
  const result = (await (await call('?summary=1&order=recent')).json()) as {
    items: Array<{ lastSequence: number; lastMessageAt: number }>;
  };
  expect(result.items[0]!.lastSequence).toBe(2);
  expect(result.items[0]!.lastMessageAt).toBeGreaterThan(0);
});

it('backfills stable sequences from an existing schema without inventing read state or timestamps', () => {
  const legacy = new DatabaseSync(':memory:');
  try {
    legacy.exec('CREATE TABLE users(id TEXT PRIMARY KEY)');
    legacy.exec(
      readFileSync(
        join(import.meta.dirname, '../migrations/0027_server_conversations.sql'),
        'utf8',
      ),
    );
    legacy.exec(
      "INSERT INTO users VALUES('alice'); INSERT INTO server_conversations VALUES('alice','s',1,'{}',1,1,NULL,'old'); INSERT INTO server_conversation_messages VALUES('alice','s','b','assistant','second',1,1),('alice','s','a','user','first',1,0)",
    );
    legacy.exec(
      readFileSync(join(import.meta.dirname, '../migrations/0041_conversation_inbox.sql'), 'utf8'),
    );
    expect(
      legacy
        .prepare('SELECT id,sequence FROM server_conversation_messages ORDER BY sequence')
        .all(),
    ).toEqual([
      { id: 'a', sequence: 1 },
      { id: 'b', sequence: 2 },
    ]);
    expect(
      legacy
        .prepare('SELECT last_sequence,read_sequence,last_message_at FROM server_conversations')
        .get(),
    ).toEqual({ last_sequence: 2, read_sequence: null, last_message_at: null });
    legacy.exec(
      "INSERT INTO server_conversation_messages(user_id,conversation_id,id,role,content,created_at,position) VALUES('alice','s','c','assistant','third',1,2)",
    );
    expect(
      legacy.prepare("SELECT sequence FROM server_conversation_messages WHERE id='c'").get(),
    ).toEqual({ sequence: 3 });
  } finally {
    legacy.close();
  }
});

const videoReplyId = 'video-reply-00000000-0000-4000-8000-000000000001';
it('stages a Video answer outside every transcript read until confirmed, then commits once', async () => {
  await put(snapshot('s', [message('video-user-1', '窗边是什么？')]));
  const stage = { id: videoReplyId, sourceMessageId: 'video-user-1', content: '一只猫。' };
  expect((await call('/s/video-replies', 'POST', stage)).status).toBe(200);
  expect((await call('/s/video-replies', 'POST', stage)).status).toBe(200);
  const before = (await (await call('/s')).json()) as {
    session: { messages: Array<{ id: string }> };
  };
  expect(before.session.messages.map((m) => m.id)).toEqual(['video-user-1']);
  const page = (await (await call('/s/messages')).json()) as { items: Array<{ id: string }> };
  expect(page.items.map((m) => m.id)).toEqual(['video-user-1']);
  expect(((await (await call('/search?q=一只猫')).json()) as { ids: string[] }).ids).toEqual([]);
  const committed = await call('/s/video-replies', 'PUT', { id: videoReplyId });
  expect(committed.status).toBe(200);
  expect(
    (
      (await committed.json()) as { session: { messages: Array<{ id: string }> } }
    ).session.messages.map((m) => m.id),
  ).toEqual(['video-user-1', videoReplyId]);
  expect((await call('/s/video-replies', 'PUT', { id: videoReplyId })).status).toBe(200);
  expect(
    ((await (await call('/s/messages')).json()) as { items: Array<{ id: string }> }).items.map(
      (m) => m.id,
    ),
  ).toEqual(['video-user-1', videoReplyId]);
  expect((await call('/s/video-replies', 'DELETE', { id: videoReplyId })).status).toBe(409);
  expect((await call('/s/video-replies', 'GET')).status).toBe(405);
});

it('cancellation tombstones a Video reply before or after staging without deleting delivered content', async () => {
  await put(snapshot('s', [message('video-user-1')]));
  const stage = { id: videoReplyId, sourceMessageId: 'video-user-1', content: '未送达' };
  expect((await call('/s/video-replies', 'DELETE', { id: videoReplyId })).status).toBe(200);
  expect((await call('/s/video-replies', 'POST', stage)).status).toBe(409);
  expect((await call('/s/video-replies', 'PUT', { id: videoReplyId })).status).toBe(409);
  const secondId = 'video-reply-00000000-0000-4000-8000-000000000002';
  expect((await call('/s/video-replies', 'POST', { ...stage, id: secondId })).status).toBe(200);
  expect((await call('/s/video-replies', 'DELETE', { id: secondId })).status).toBe(200);
  expect((await call('/s/video-replies', 'PUT', { id: secondId })).status).toBe(409);
  expect(
    (
      (await (await call('/s')).json()) as { session: { messages: Array<{ id: string }> } }
    ).session.messages.map((m) => m.id),
  ).toEqual(['video-user-1']);
});

it('isolates staged Video replies by owner and expires abandoned pending text', async () => {
  await put(snapshot('s', [message('video-user-1')]));
  const stage = { id: videoReplyId, sourceMessageId: 'video-user-1', content: '私密回复' };
  expect((await call('/s/video-replies', 'POST', stage, 'bob')).status).toBe(404);
  expect((await call('/s/video-replies', 'POST', stage, 'alice', 'bob')).status).toBe(403);
  expect(
    (await call('/s/video-replies', 'POST', { ...stage, sourceMessageId: 'missing' })).status,
  ).toBe(409);
  expect((await call('/s/video-replies', 'POST', stage)).status).toBe(200);
  expect((await call('/s/video-replies', 'PUT', { id: videoReplyId }, 'bob')).status).toBe(404);
  await env.DB.prepare(
    `UPDATE video_reply_staging SET updated_at=1 WHERE user_id='alice' AND conversation_id='s'`,
  ).run();
  expect((await call('/s/video-replies', 'PUT', { id: videoReplyId })).status).toBe(409);
  expect(
    await env.DB.prepare(
      `SELECT state,content FROM video_reply_staging WHERE user_id='alice' AND conversation_id='s'`,
    ).first(),
  ).toEqual({ state: 'cancelled', content: null });
  expect(
    (
      (await (await call('/s')).json()) as { session: { messages: Array<{ id: string }> } }
    ).session.messages.map((m) => m.id),
  ).toEqual(['video-user-1']);
});

it('joins the caller’s own ready relationship avatar into summaries and nothing else', async () => {
  for (const [user, id, photo] of [
    ['alice', 'rel', 'alicephoto'],
    ['bob', 'bobrel', 'bobphoto'],
  ] as const) {
    await env.DB.prepare(
      `INSERT INTO character_relationships(user_id,id,character_id,ai_nickname,user_preferred_name,relationship_type,notes,version,created_at,updated_at) VALUES (?,?,'character','','','','',1,1,1)`,
    )
      .bind(user, id)
      .run();
    await env.DB.prepare(
      "INSERT INTO user_photos (id,user_id,object_key,visibility,created_at,status) VALUES (?,?,?,'private',1,'ready')",
    )
      .bind(photo, user, `${user}/${photo}`)
      .run();
  }
  await env.DB.prepare(
    "INSERT INTO character_appearances(user_id,relationship_id,photo_id,scale,position,version) VALUES ('alice','rel','alicephoto',35,'right',1),('bob','bobrel','bobphoto',35,'right',1)",
  ).run();
  const bound = (id: string) => {
    const session = snapshot(id);
    return {
      ...session,
      metadata: { ...session.metadata, promptPresetId: 'character', relationshipId: 'rel' },
    };
  };
  await put(bound('own'));
  await put(snapshot('plain'));
  const summaries = async (user = 'alice') =>
    (
      (await (await call('?summary=1&order=recent', 'GET', undefined, user)).json()) as {
        items: Array<{ id: string; avatarPhotoId: string | null }>;
      }
    ).items;
  expect(await summaries()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'own', avatarPhotoId: 'alicephoto' }),
      expect.objectContaining({ id: 'plain', avatarPhotoId: null }),
    ]),
  );
  // A metadata reference to another account's relationship never exposes its photo.
  await env.DB.prepare(
    "INSERT INTO server_conversations(user_id,id,created_at,metadata,revision,updated_at,mutation_id) VALUES ('alice','foreign',1,?,1,1,'m')",
  )
    .bind(JSON.stringify({ relationshipId: 'bobrel' }))
    .run();
  // Bob's appearance pointing at Alice's photo is not resolved for Bob either.
  await env.DB.prepare(
    "UPDATE character_appearances SET photo_id='alicephoto' WHERE user_id='bob'",
  ).run();
  await env.DB.prepare(
    "INSERT INTO server_conversations(user_id,id,created_at,metadata,revision,updated_at,mutation_id) VALUES ('bob','borrowed',1,?,1,1,'m')",
  )
    .bind(JSON.stringify({ relationshipId: 'bobrel' }))
    .run();
  expect((await summaries()).find((item) => item.id === 'foreign')?.avatarPhotoId).toBeNull();
  expect((await summaries('bob')).find((item) => item.id === 'borrowed')?.avatarPhotoId).toBeNull();
  await env.DB.prepare("UPDATE user_photos SET status='uploading' WHERE id='alicephoto'").run();
  expect((await summaries()).find((item) => item.id === 'own')?.avatarPhotoId).toBeNull();
});
