import { afterEach, beforeEach, expect, it } from 'vitest';
import { handleMemoryContext } from './memory-context';
import { expireMediumMemories, handlePersonalMemories } from './personal-memory';
import { stageConversationHistoryMemories, stageSegmentedMemory } from './segmented-memory';
import { sha256Hex, type SessionEnv } from './session-domain';
import { createTestDb } from './test-helpers';

let db: ReturnType<typeof createTestDb>;
let env: SessionEnv;

async function addConversation(
  userId: string,
  id: string,
  relationshipId: string,
  characterId: string,
) {
  await env.DB.prepare(
    `INSERT INTO server_conversations(user_id,id,created_at,metadata,updated_at,mutation_id)
     VALUES(?,?,1,?,1,'mutation')`,
  )
    .bind(userId, id, JSON.stringify({ relationshipId, promptPresetId: characterId }))
    .run();
}

async function addMessage(
  userId: string,
  conversationId: string,
  id: string,
  role: string,
  content: string,
) {
  await env.DB.prepare(
    `INSERT INTO server_conversation_messages
       (user_id,conversation_id,id,role,content,created_at,position) VALUES(?,?,?,?,?,1,1)`,
  )
    .bind(userId, conversationId, id, role, content)
    .run();
}

async function context(path = '', query = '') {
  return (await handleMemoryContext(
    new Request(`https://0xnullai.com/api/auth/memory-context${path}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer alice', 'X-Account-Id': 'alice' },
      body: JSON.stringify({ conversationId: 'c1', query }),
    }),
    env,
    {},
  ))!;
}

async function confirm(memory: Record<string, unknown>) {
  return (await handlePersonalMemories(
    new Request(`https://0xnullai.com/api/auth/personal-memories/${memory.id}`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer alice', 'X-Account-Id': 'alice' },
      body: JSON.stringify({
        kind: memory.kind,
        title: memory.title,
        content: memory.content,
        version: memory.version,
        scope: 'relationship',
        relationshipId: 'r',
        tier: 'medium',
        state: 'active',
      }),
    }),
    env,
    {},
  ))!;
}

beforeEach(async () => {
  db = createTestDb();
  env = { DB: db.DB } as SessionEnv;
  for (const id of ['alice', 'bob']) {
    await env.DB.prepare(
      'INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,?,1)',
    )
      .bind(id, id, id, 'unused')
      .run();
    await env.DB.prepare(
      'INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,1,?)',
    )
      .bind(await sha256Hex(id), id, Date.now() + 60_000)
      .run();
  }
  for (const [id, relationship, character] of [
    ['alice', 'r', 'card'],
    ['alice', 'other', 'other-card'],
    ['bob', 'r', 'card'],
  ]) {
    await env.DB.prepare(
      `INSERT INTO character_relationships(user_id,id,character_id,ai_nickname,user_preferred_name,
       relationship_type,notes,version,created_at,updated_at)
       VALUES(?,?,?,'','','','',1,1,1)`,
    )
      .bind(id, relationship, character)
      .run();
  }
  await addConversation('alice', 'c1', 'r', 'card');
  await addConversation('alice', 'c2', 'r', 'card');
  await addConversation('alice', 'other-c', 'other', 'other-card');
  await addConversation('bob', 'bob-c', 'r', 'card');
  await addMessage('alice', 'c1', 'u1', 'user', '我的同事小林周五准备面试。');
  await addMessage('alice', 'c1', 'a1', 'assistant', '我猜小林已经拿到工作。');
  await addMessage('alice', 'c2', 'u2', 'user', '我还想在小林面试后问问她的感受。');
  await addMessage('alice', 'other-c', 'o1', 'user', '另一个角色知道的秘密。');
  await addMessage('bob', 'bob-c', 'b1', 'user', 'Bob 的私人秘密。');
});
afterEach(() => db.close());

it('stages a cross-conversation, owner-only extractive candidate; confirmation controls injection', async () => {
  const response = await context('/suggestions');
  expect(response.status).toBe(200);
  const { items } = (await response.json()) as { items: Array<Record<string, unknown>> };
  const segmented = items.find(
    (item) => Array.isArray(item.sourceRefs) && (item.sourceRefs as unknown[]).length > 0,
  )!;
  expect(segmented).toMatchObject({ tier: 'medium', state: 'suggested' });
  expect(segmented.sourceRefs).toEqual([
    { conversationId: 'c1', messageId: 'u1' },
    { conversationId: 'c2', messageId: 'u2' },
  ]);
  expect(segmented.content).toContain('第 1 段');
  expect(segmented.content).toContain('我的同事小林周五准备面试。');
  expect(segmented.content).toContain('我还想在小林面试后问问她的感受。');
  expect(JSON.stringify(segmented)).not.toContain('拿到工作');
  expect(JSON.stringify(segmented)).not.toContain('秘密');
  expect(
    await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM memory_summary_sources WHERE user_id=? AND memory_id=?',
    )
      .bind('alice', segmented.id)
      .first(),
  ).toEqual({ n: 2 });
  expect(await (await context('', '小林面试')).json()).toMatchObject({ mediumTerm: [] });
  expect((await confirm(segmented)).status).toBe(200);
  const active = (await (await context('', '小林面试')).json()) as {
    mediumTerm: Array<{ id: string }>;
  };
  expect(active.mediumTerm.map(({ id }) => id)).toContain(segmented.id);

  const ownList = (await handlePersonalMemories(
    new Request(
      'https://0xnullai.com/api/auth/personal-memories?scope=relationship&relationshipId=r',
      {
        headers: { Authorization: 'Bearer alice', 'X-Account-Id': 'alice' },
      },
    ),
    env,
    {},
  ))!;
  expect(JSON.stringify(await ownList.json())).toContain('sourceRefs');
  const otherAccount = (await handlePersonalMemories(
    new Request(
      'https://0xnullai.com/api/auth/personal-memories?scope=relationship&relationshipId=r',
      {
        headers: { Authorization: 'Bearer bob', 'X-Account-Id': 'bob' },
      },
    ),
    env,
    {},
  ))!;
  expect(await otherAccount.json()).toMatchObject({ items: [] });
});

it('stages stable complete older-user windows without treating excerpts as confirmed facts', async () => {
  for (let position = 2; position <= 20; position++)
    await env.DB.prepare(
      `INSERT INTO server_conversation_messages
       (user_id,conversation_id,id,role,content,created_at,position)
       VALUES('alice','c1',?,'user',?,1,?)`,
    )
      .bind(`u${position}`, `第 ${position} 条用户原话`, position)
      .run();
  const firstResponse = await context('/suggestions');
  const firstItems = (await firstResponse.json()) as {
    items: Array<{ id: string; content: string; sourceRefs: Array<{ messageId: string }> }>;
  };
  const first = firstItems.items.find((item) => item.id.startsWith('history-'))!;
  expect(first.sourceRefs.map(({ messageId }) => messageId)).toEqual([
    'u1',
    'u2',
    'u3',
    'u4',
    'u5',
    'u6',
    'u7',
    'u8',
  ]);
  expect(first.content).toContain('第 8 条用户原话');
  expect(first.content).not.toContain('拿到工作');
  expect(first.content.length).toBeLessThan(4000);
  expect(await (await context('', '小林面试')).json()).toMatchObject({ mediumTerm: [] });
  const saved = await env.DB.prepare('SELECT * FROM personal_memories WHERE user_id=? AND id=?')
    .bind('alice', first.id)
    .first();
  expect((await confirm(saved!)).status).toBe(200);
  const active = (await (await context('', '小林面试')).json()) as {
    mediumTerm: Array<{ id: string }>;
  };
  expect(active.mediumTerm.map(({ id }) => id)).toContain(first.id);

  for (let position = 21; position <= 28; position++)
    await env.DB.prepare(
      `INSERT INTO server_conversation_messages
       (user_id,conversation_id,id,role,content,created_at,position)
       VALUES('alice','c1',?,'user',?,1,?)`,
    )
      .bind(`u${position}`, `第 ${position} 条用户原话`, position)
      .run();
  const secondResponse = await context('/suggestions');
  const secondItems = (await secondResponse.json()) as {
    items: Array<{ id: string; sourceRefs: Array<{ messageId: string }> }>;
  };
  const second = secondItems.items.find((item) => item.id.startsWith('history-'))!;
  expect(second.id).not.toBe(first.id);
  expect(second.sourceRefs.map(({ messageId }) => messageId)).toEqual(
    Array.from({ length: 8 }, (_, index) => `u${index + 9}`),
  );
  expect(secondItems.items.filter((item) => item.id.startsWith('history-'))).toHaveLength(1);

  await env.DB.prepare(
    "UPDATE server_conversation_messages SET content='用户已纠正原话' WHERE user_id='alice' AND conversation_id='c1' AND id='u4'",
  ).run();
  expect(
    await env.DB.prepare(
      'SELECT content,deleted_at FROM personal_memories WHERE user_id=? AND id=?',
    )
      .bind('alice', first.id)
      .first(),
  ).toMatchObject({ content: '', deleted_at: expect.any(Number) });
  expect(await (await context('', '小林面试')).json()).toMatchObject({ mediumTerm: [] });
  expect(
    (await (await context('/suggestions')).json()) as { items: Array<{ id: string }> },
  ).not.toEqual(
    expect.objectContaining({
      items: expect.arrayContaining([expect.objectContaining({ id: first.id })]),
    }),
  );
});

it('includes tied-position older messages by ID and never crosses the short-term boundary', async () => {
  await env.DB.prepare(
    "DELETE FROM server_conversation_messages WHERE user_id='alice' AND conversation_id='c1'",
  ).run();
  for (let index = 1; index <= 20; index++)
    await env.DB.prepare(
      `INSERT INTO server_conversation_messages
       (user_id,conversation_id,id,role,content,created_at,position)
       VALUES('alice','c1',?,'user',?,1,1)`,
    )
      .bind(`m${String(index).padStart(2, '0')}`, `第 ${index} 条小林的原话`)
      .run();
  const response = await context('', '小林');
  const recap = (await response.json()) as { historyRecap: Array<{ id: string }> };
  expect(recap.historyRecap.map(({ id }) => id)).toContain('m08');
  expect(recap.historyRecap.map(({ id }) => id)).not.toContain('m09');
  const staged = await stageConversationHistoryMemories(env, 'alice', 'r', 'c1', {
    position: 1,
    id: 'm09',
  });
  expect(staged).toHaveLength(1);
  expect(JSON.parse(staged[0]!.source_refs)).toEqual(
    Array.from({ length: 8 }, (_, index) => ({
      conversationId: 'c1',
      messageId: `m${String(index + 1).padStart(2, '0')}`,
    })),
  );
});

it('backfills every older window over repeated reviews and does not resurrect deleted candidates', async () => {
  for (let position = 2; position <= 48; position++)
    await env.DB.prepare(
      `INSERT INTO server_conversation_messages
       (user_id,conversation_id,id,role,content,created_at,position)
       VALUES('alice','c1',?,'user',?,1,?)`,
    )
      .bind(`u${position}`, `第 ${position} 条用户原话`, position)
      .run();
  const before = { position: 100, id: 'end' };
  const first = await stageConversationHistoryMemories(env, 'alice', 'r', 'c1', before);
  const second = await stageConversationHistoryMemories(env, 'alice', 'r', 'c1', before);
  expect(first).toHaveLength(3);
  expect(second).toHaveLength(3);
  expect(new Set([...first, ...second].map((item) => item.id)).size).toBe(6);
  await env.DB.prepare('UPDATE personal_memories SET deleted_at=10 WHERE user_id=? AND id=?')
    .bind('alice', first[0]!.id)
    .run();
  expect(await stageConversationHistoryMemories(env, 'alice', 'r', 'c1', before)).toEqual([]);
});

it('requires at least two eligible conversations and never stages from another relationship or owner', async () => {
  await env.DB.prepare(
    "UPDATE server_conversations SET deleted_at=5 WHERE user_id='alice' AND id='c2'",
  ).run();
  expect(await stageSegmentedMemory(env, 'alice', 'r')).toBeNull();
  expect(await stageSegmentedMemory(env, 'bob', 'r')).toBeNull();
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM memory_summary_sources').first();
  expect(count).toEqual({ n: 0 });
});

it('invalidates confirmed text on any linked message edit/delete and keeps a stable tombstone', async () => {
  const row = (await stageSegmentedMemory(env, 'alice', 'r'))!;
  expect(
    (
      await confirm({
        ...row,
        id: row.id,
        kind: row.kind,
        title: row.title,
        content: row.content,
        version: row.version,
      })
    ).status,
  ).toBe(200);
  await env.DB.prepare(
    "UPDATE server_conversation_messages SET content='用户修正了这句话' WHERE user_id='alice' AND conversation_id='c2' AND id='u2'",
  ).run();
  expect(
    await env.DB.prepare(
      'SELECT content,deleted_at FROM personal_memories WHERE user_id=? AND id=?',
    )
      .bind('alice', row.id)
      .first<{ content: string; deleted_at: number | null }>(),
  ).toMatchObject({
    content: '',
    deleted_at: expect.any(Number),
  });
  expect(await stageSegmentedMemory(env, 'alice', 'r')).toBeNull();
  expect(
    (
      await confirm({
        id: row.id,
        kind: row.kind,
        title: row.title,
        content: row.content,
        version: row.version + 1,
      })
    ).status,
  ).toBe(409);
});

it.each([
  'message-delete',
  'role-change',
  'conversation-delete',
  'conversation-rebind',
  'relationship-delete',
])('invalidates all segments on %s', async (action) => {
  const row = (await stageSegmentedMemory(env, 'alice', 'r'))!;
  if (action === 'message-delete') {
    await env.DB.prepare(
      "DELETE FROM server_conversation_messages WHERE user_id='alice' AND conversation_id='c2' AND id='u2'",
    ).run();
  } else if (action === 'role-change') {
    await env.DB.prepare(
      "UPDATE server_conversation_messages SET role='assistant' WHERE user_id='alice' AND conversation_id='c2' AND id='u2'",
    ).run();
  } else if (action === 'conversation-delete') {
    await env.DB.prepare(
      "UPDATE server_conversations SET deleted_at=5 WHERE user_id='alice' AND id='c2'",
    ).run();
  } else if (action === 'relationship-delete') {
    await env.DB.prepare(
      "UPDATE character_relationships SET deleted_at=5 WHERE user_id='alice' AND id='r'",
    ).run();
  } else {
    await env.DB.prepare(
      "UPDATE server_conversations SET metadata=? WHERE user_id='alice' AND id='c2'",
    )
      .bind(JSON.stringify({ relationshipId: 'other', promptPresetId: 'other-card' }))
      .run();
  }
  expect(
    await env.DB.prepare(
      'SELECT title,content,deleted_at FROM personal_memories WHERE user_id=? AND id=?',
    )
      .bind('alice', row.id)
      .first(),
  ).toMatchObject({ title: '', content: '', deleted_at: expect.any(Number) });
  expect(
    await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM memory_summary_sources WHERE user_id=? AND memory_id=?',
    )
      .bind('alice', row.id)
      .first(),
  ).toEqual({ n: 0 });
  expect(await stageSegmentedMemory(env, 'alice', 'r')).toBeNull();
});

it('rechecks exact source content inside the final INSERT when a message changes after reading', async () => {
  const originalDb = env.DB;
  env.DB = {
    prepare(sql: string) {
      const statement = originalDb.prepare(sql);
      if (!sql.includes('WITH refs AS')) return statement;
      return {
        bind(...args: unknown[]) {
          const bound = statement.bind(...args);
          return {
            async first() {
              await originalDb
                .prepare(
                  "UPDATE server_conversation_messages SET content='已撤回' WHERE user_id='alice' AND conversation_id='c2' AND id='u2'",
                )
                .run();
              return bound.first();
            },
          };
        },
      };
    },
  } as SessionEnv['DB'];
  expect(await stageSegmentedMemory(env, 'alice', 'r')).toBeNull();
  expect(await originalDb.prepare('SELECT COUNT(*) AS n FROM personal_memories').first()).toEqual({
    n: 0,
  });
});

it('does not recreate a candidate explicitly deleted by its owner', async () => {
  const row = (await stageSegmentedMemory(env, 'alice', 'r'))!;
  const deleted = await handlePersonalMemories(
    new Request(`https://0xnullai.com/api/auth/personal-memories/${row.id}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer alice', 'X-Account-Id': 'alice' },
      body: JSON.stringify({ version: row.version }),
    }),
    env,
    {},
  );
  expect(deleted?.status).toBe(200);
  expect(await stageSegmentedMemory(env, 'alice', 'r')).toBeNull();
});

it('excludes expired confirmed segments and cascades source links on account deletion', async () => {
  const row = (await stageSegmentedMemory(env, 'alice', 'r'))!;
  expect((await confirm({ ...row })).status).toBe(200);
  await env.DB.prepare('UPDATE personal_memories SET expires_at=1 WHERE user_id=? AND id=?')
    .bind('alice', row.id)
    .run();
  expect(await (await context('', '小林')).json()).toMatchObject({ mediumTerm: [] });
  expect(await expireMediumMemories(env, Date.now())).toBe(1);
  expect(
    await env.DB.prepare(
      'SELECT title,content,deleted_at FROM personal_memories WHERE user_id=? AND id=?',
    )
      .bind('alice', row.id)
      .first(),
  ).toMatchObject({ title: '', content: '', deleted_at: expect.any(Number) });
  await env.DB.prepare("DELETE FROM users WHERE id='alice'").run();
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM memory_summary_sources').first()).toEqual({
    n: 0,
  });
});

it('does not create a segment past the account-wide 200 active memory limit', async () => {
  await env.DB.batch(
    Array.from({ length: 200 }, (_, index) =>
      env.DB.prepare(
        `INSERT INTO personal_memories(user_id,id,kind,title,content,version,created_at,updated_at)
       VALUES('alice',?,'note','existing','saved',1,1,1)`,
      ).bind(`existing-${index}`),
    ),
  );
  expect(await stageSegmentedMemory(env, 'alice', 'r')).toBeNull();
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM memory_summary_sources').first()).toEqual({
    n: 0,
  });
});

it('rejects confirmation of an expired cross-conversation candidate before the cleanup cron', async () => {
  const row = (await stageSegmentedMemory(env, 'alice', 'r'))!;
  await env.DB.prepare('UPDATE personal_memories SET expires_at=1 WHERE user_id=? AND id=?')
    .bind('alice', row.id)
    .run();
  expect((await confirm({ ...row })).status).toBe(409);
  expect(
    await env.DB.prepare('SELECT state,expires_at FROM personal_memories WHERE user_id=? AND id=?')
      .bind('alice', row.id)
      .first(),
  ).toEqual({ state: 'suggested', expires_at: 1 });
});
