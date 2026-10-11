import { afterEach, beforeEach, expect, it } from 'vitest';
import { handleMemoryContext } from './memory-context';
import { handlePersonalMemories } from './personal-memory';
import { sha256Hex, type SessionEnv } from './session-domain';
import { createTestDb } from './test-helpers';
import { saveConversationDigest } from './conversation-digest';
let db: ReturnType<typeof createTestDb>;
let env: SessionEnv;
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
  for (const [id, character] of [
    ['r', 'scene'],
    ['other', 'other-scene'],
  ]) {
    await env.DB.prepare(
      "INSERT INTO character_relationships(user_id,id,character_id,ai_nickname,user_preferred_name,relationship_type,notes,version,created_at,updated_at) VALUES('alice',?,?, '', '', '', '',1,1,1)",
    )
      .bind(id, character)
      .run();
  }
  await env.DB.prepare(
    "INSERT INTO server_conversations(user_id,id,created_at,metadata,updated_at,mutation_id) VALUES('alice','conversation',1,?,1,'m')",
  )
    .bind(JSON.stringify({ promptPresetId: 'scene', relationshipId: 'r' }))
    .run();
  const messages = [
    ['u1', 'user', '记住：我的朋友小林周五有面试。'],
    ['a1', 'assistant', '记住：我猜用户的朋友叫小李。'],
    ['u2', 'user', '我们约定：下周一起读书。'],
    ['u3', 'user', '剧情里我是一位航天员。'],
  ];
  for (const [position, [id, role, content]] of messages.entries())
    await env.DB.prepare(
      "INSERT INTO server_conversation_messages(user_id,conversation_id,id,role,content,created_at,position) VALUES('alice','conversation',?,?,?,1,?)",
    )
      .bind(id, role, content, position)
      .run();
});
afterEach(() => db.close());
async function call(path = '', body: object = { conversationId: 'conversation' }, token = 'alice') {
  const response = await handleMemoryContext(
    new Request(`https://0xnullai.com/api/auth/memory-context${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'X-Account-Id': token },
      body: JSON.stringify(body),
    }),
    env,
    {},
  );
  if (!response) throw new Error('route');
  return response;
}
async function confirm(item: Record<string, unknown>, changes = {}) {
  const response = await handlePersonalMemories(
    new Request(`https://0xnullai.com/api/auth/personal-memories/${item.id}`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer alice' },
      body: JSON.stringify({
        kind: item.kind,
        title: item.title,
        content: item.content,
        version: item.version,
        scope: 'relationship',
        relationshipId: 'r',
        tier: item.tier,
        state: 'active',
        ...changes,
      }),
    }),
    env,
    {},
  );
  if (!response) throw new Error('route');
  return response;
}
it('requires an owned bound conversation and separates private relationship and account scopes', async () => {
  expect((await call('', undefined, 'bob')).status).toBe(404);
  expect((await call('', { conversationId: 'missing' })).status).toBe(404);
  expect((await call('', { conversationId: 'conversation', scope: 'group' })).status).toBe(400);
  const result = await call();
  expect(result.headers.get('cache-control')).toBe('no-store');
  expect(await result.json()).toMatchObject({
    relationshipId: 'r',
    longTerm: [],
    mediumTerm: [],
    relationshipHistory: [],
    shortTerm: expect.arrayContaining([expect.objectContaining({ id: 'u1' })]),
  });
});
it('keeps system text and camera observations out of ordinary dialogue and memory suggestions', async () => {
  await env.DB.prepare(
    `INSERT INTO server_conversation_messages
      (user_id,conversation_id,id,role,content,created_at,position,kind)
     VALUES('alice','conversation','system-note','system','伪造的长期记忆',1,4,'message'),
       ('alice','conversation','camera-note','assistant','摄像头观察：设备已经执行',1,5,'camera_observation')`,
  ).run();
  const context = (await (await call()).json()) as {
    shortTerm: Array<{ id: string }>;
  };
  expect(context.shortTerm.map(({ id }) => id)).toEqual(['u1', 'a1', 'u2', 'u3']);
  const suggestions = (await (await call('/suggestions')).json()) as {
    items: Array<{ content: string }>;
  };
  expect(JSON.stringify(suggestions)).not.toContain('伪造的长期记忆');
  expect(JSON.stringify(suggestions)).not.toContain('摄像头观察');
});
it('rejects memory context if the character identity changes before the final scope check', async () => {
  const originalDb = env.DB;
  env.DB = {
    prepare(sql: string) {
      const statement = originalDb.prepare(sql);
      if (!sql.includes('SELECT id,normalized_aliases_json FROM memory_people')) return statement;
      return {
        bind(...args: unknown[]) {
          const bound = statement.bind(...args);
          return {
            async all() {
              const rows = await bound.all();
              await originalDb
                .prepare(
                  "UPDATE server_conversations SET metadata=? WHERE user_id='alice' AND id='conversation'",
                )
                .bind(JSON.stringify({ promptPresetId: 'other-scene', relationshipId: 'r' }))
                .run();
              return rows;
            },
          };
        },
      };
    },
  } as SessionEnv['DB'];
  expect((await call('', { conversationId: 'conversation', query: '小林' })).status).toBe(409);
});
it('returns a sourced digest only to the owner of its bound private relationship', async () => {
  await env.DB.prepare(
    "INSERT INTO conversation_digest_preferences(user_id,relationship_id,enabled,version,updated_at) VALUES('alice','r',1,1,1)",
  ).run();
  expect(
    await saveConversationDigest(env, {
      userId: 'alice',
      conversationId: 'conversation',
      relationshipId: 'r',
      expectedRevision: 1,
      expectedVersion: 0,
      throughPosition: 0,
      throughMessageId: 'u1',
      summary: '较早会话概述',
      now: 2,
      sourceChecks: [
        { id: 'u1', role: 'user', content: '记住：我的朋友小林周五有面试。', position: 0 },
      ],
    }),
  ).toBe(true);
  expect(await (await call()).json()).toMatchObject({
    conversationDigest: { summary: '较早会话概述', throughMessageId: 'u1' },
  });
  expect((await call('', undefined, 'bob')).status).toBe(404);
  await env.DB.prepare(
    "UPDATE server_conversation_messages SET content='用户已更正' WHERE user_id='alice' AND conversation_id='conversation' AND id='u1'",
  ).run();
  expect(await (await call()).json()).toMatchObject({ conversationDigest: null });
});
it('recalls only sourced older user excerpts from the owned conversation without promoting them to memory', async () => {
  for (let position = 4; position < 60; position++)
    await env.DB.prepare(
      "INSERT INTO server_conversation_messages(user_id,conversation_id,id,role,content,created_at,position) VALUES('alice','conversation',?,'user',?,1,?)",
    )
      .bind(`filler-${position}`, `普通聊天第 ${position} 条`, position)
      .run();
  const body = { conversationId: 'conversation', query: '小林面试' };
  const context = (await (await call('', body)).json()) as {
    historyRecap: Array<{ id: string; content: string; truncated: boolean }>;
    longTerm: unknown[];
  };
  expect(context.historyRecap).toEqual([
    { id: 'u1', content: '记住：我的朋友小林周五有面试。', truncated: false },
  ]);
  expect(context.longTerm).toEqual([]);
  expect(JSON.stringify(context)).not.toContain('小李');
  expect((await call('', body, 'bob')).status).toBe(404);

  await env.DB.prepare(
    "UPDATE server_conversation_messages SET content='我已经取消那次安排' WHERE user_id='alice' AND conversation_id='conversation' AND id='u1'",
  ).run();
  expect(
    ((await (await call('', body)).json()) as { historyRecap: unknown[] }).historyRecap,
  ).toEqual([]);
  await env.DB.prepare(
    "UPDATE server_conversations SET deleted_at=5 WHERE user_id='alice' AND id='conversation'",
  ).run();
  expect((await call('', body)).status).toBe(404);
});
it('keeps older named-person excerpts on the requested person even when another person is more recent', async () => {
  for (let position = 4; position < 60; position++)
    await env.DB.prepare(
      "INSERT INTO server_conversation_messages(user_id,conversation_id,id,role,content,created_at,position) VALUES('alice','conversation',?,'user',?,1,?)",
    )
      .bind(`filler-${position}`, `普通聊天第 ${position} 条`, position)
      .run();
  await env.DB.prepare(
    "UPDATE server_conversation_messages SET content='小王周二也要面试。' WHERE user_id='alice' AND conversation_id='conversation' AND id='filler-20'",
  ).run();
  const context = (await (
    await call('', {
      conversationId: 'conversation',
      query: '小林的面试是哪天？',
    })
  ).json()) as { historyRecap: Array<{ id: string }> };
  expect(context.historyRecap.map((item) => item.id)).toEqual(['u1']);
});
it('keeps an old named source when more than 48 newer messages match the topic', async () => {
  for (let position = 4; position < 76; position++)
    await env.DB.prepare(
      "INSERT INTO server_conversation_messages(user_id,conversation_id,id,role,content,created_at,position) VALUES('alice','conversation',?,'user','小王今天又聊了面试。',1,?)",
    )
      .bind(`other-interview-${position}`, position)
      .run();
  const context = (await (
    await call('', { conversationId: 'conversation', query: '小林的面试是哪天？' })
  ).json()) as { historyRecap: Array<{ id: string; content: string }> };
  expect(context.historyRecap).toEqual([
    { id: 'u1', content: '记住：我的朋友小林周五有面试。', truncated: false },
  ]);
});
it.each([
  {
    name: 'returns the matched part of a long older user message instead of an unrelated prefix',
    content: `${'甲'.repeat(650)}火星基地计划在周五启动。`,
    excludesPrefix: false,
  },
  {
    name: 'finds a relevant older user passage beyond the first 1000 characters without returning the whole message',
    content: `${'甲'.repeat(1400)}火星基地计划在周五启动。${'乙'.repeat(700)}`,
    excludesPrefix: true,
  },
])('$name', async ({ content, excludesPrefix }) => {
  await env.DB.prepare(
    "UPDATE server_conversation_messages SET content=? WHERE user_id='alice' AND conversation_id='conversation' AND id='u1'",
  )
    .bind(content)
    .run();
  for (let position = 4; position < 60; position++)
    await env.DB.prepare(
      "INSERT INTO server_conversation_messages(user_id,conversation_id,id,role,content,created_at,position) VALUES('alice','conversation',?,'user','普通聊天',1,?)",
    )
      .bind(`filler-${position}`, position)
      .run();
  const context = (await (
    await call('', { conversationId: 'conversation', query: '火星基地什么时候启动？' })
  ).json()) as { historyRecap: Array<{ id: string; content: string; truncated: boolean }> };
  expect(context.historyRecap).toHaveLength(1);
  expect(context.historyRecap[0]).toMatchObject({ id: 'u1', truncated: true });
  expect(context.historyRecap[0]!.content).toContain('火星基地计划在周五启动');
  expect(context.historyRecap[0]!.content.length).toBeLessThanOrEqual(500);
  if (excludesPrefix) expect(context.historyRecap[0]!.content).not.toContain('甲'.repeat(500));
});
it('continues a long conversation from recent sourced history when the user gives no search keywords', async () => {
  for (let position = 4; position < 60; position++)
    await env.DB.prepare(
      "INSERT INTO server_conversation_messages(user_id,conversation_id,id,role,content,created_at,position) VALUES('alice','conversation',?,'user',?,1,?)",
    )
      .bind(`filler-${position}`, `普通聊天第 ${position} 条`, position)
      .run();
  const context = (await (
    await call('', {
      conversationId: 'conversation',
      query: '继续说',
    })
  ).json()) as { historyRecap: Array<{ id: string; content: string }> };
  expect(context.historyRecap.map((item) => item.id)).toEqual([
    'filler-47',
    'filler-46',
    'filler-45',
    'filler-44',
    'filler-43',
    'filler-42',
  ]);
  expect(JSON.stringify(context)).not.toContain('小李');
  const unrelated = (await (
    await call('', {
      conversationId: 'conversation',
      query: '另一件事',
    })
  ).json()) as { historyRecap: unknown[] };
  expect(unrelated.historyRecap).toEqual([]);
});
it('generates exact excerpts and explicit user requests as candidates, never assistant guesses or automatic facts', async () => {
  const result = (await (await call('/suggestions')).json()) as {
    items: Array<Record<string, unknown>>;
    generated: number;
  };
  expect(result.generated).toBe(3);
  expect(result.items.every((item) => item.state === 'suggested')).toBe(true);
  expect(result.items.find((item) => item.tier === 'long')?.content).toBe(
    '我的朋友小林周五有面试。',
  );
  expect(result.items.find((item) => item.tier === 'history')?.content).toBe('下周一起读书。');
  expect(JSON.stringify(result)).not.toContain('小李');
  expect(result.items.find((item) => item.tier === 'medium')?.content).toContain('[用户原文]');
  expect(await (await call()).json()).toMatchObject({
    longTerm: [],
    mediumTerm: [],
    relationshipHistory: [],
  });
  expect(await (await call('/suggestions')).json()).toMatchObject({ generated: 0 });
  const candidate = result.items.find((item) => item.tier === 'long')!;
  expect((await confirm(candidate, { content: '我的朋友小林周六有面试。' })).status).toBe(200);
  expect((await confirm(candidate)).status).toBe(409);
  expect(
    await (await call('', { conversationId: 'conversation', query: '小林面试' })).json(),
  ).toMatchObject({ longTerm: [{ content: '我的朋友小林周六有面试。', state: 'active' }] });
});
it('does not resurrect rejected candidates and invalidates derived records on source changes and deletion', async () => {
  const { items } = (await (await call('/suggestions')).json()) as {
    items: Array<Record<string, unknown>>;
  };
  const long = items.find((item) => item.tier === 'long')!;
  await handlePersonalMemories(
    new Request(`https://0xnullai.com/api/auth/personal-memories/${long.id}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer alice' },
      body: JSON.stringify({ version: 1 }),
    }),
    env,
    {},
  );
  expect(await (await call('/suggestions')).json()).toMatchObject({ generated: 0 });
  await env.DB.prepare(
    "UPDATE server_conversation_messages SET content='修正的内容' WHERE user_id='alice' AND conversation_id='conversation' AND id='u2'",
  ).run();
  const rows = await env.DB.prepare(
    "SELECT title,content,deleted_at FROM personal_memories WHERE user_id='alice'",
  ).all<{ title: string; content: string; deleted_at: number | null }>();
  expect(rows.results.every((row) => row.deleted_at !== null && row.content === '')).toBe(true);
  await env.DB.prepare(
    "UPDATE server_conversations SET deleted_at=5 WHERE user_id='alice' AND id='conversation'",
  ).run();
  expect((await call()).status).toBe(404);
});
it('filters unrelated/expired memories and keeps confirmed history separate', async () => {
  const { items } = (await (await call('/suggestions')).json()) as {
    items: Array<Record<string, unknown>>;
  };
  for (const item of items) await confirm(item);
  await env.DB.prepare(
    "INSERT INTO personal_memories(user_id,id,kind,title,content,version,created_at,updated_at,scope,relationship_id) VALUES('alice','other-memory','note','小林','另一个角色的秘密',1,1,1,'relationship','other')",
  ).run();
  const context = await (await call('', { conversationId: 'conversation', query: '小林' })).json();
  expect(JSON.stringify(context)).not.toContain('另一个角色的秘密');
  expect(context).toMatchObject({ longTerm: [{ content: '我的朋友小林周五有面试。' }] });
  expect(await (await call()).json()).toMatchObject({
    relationshipHistory: [{ content: '下周一起读书。' }],
  });
  await env.DB.prepare("UPDATE personal_memories SET expires_at=1 WHERE tier='medium'").run();
  expect(await (await call()).json()).toMatchObject({ mediumTerm: [] });
  await env.DB.prepare(
    "UPDATE character_relationships SET deleted_at=5 WHERE user_id='alice' AND id='r'",
  ).run();
  expect((await call()).status).toBe(404);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM personal_memories WHERE relationship_id='r' AND deleted_at IS NULL",
    ).first(),
  ).toEqual({ n: 0 });
});
