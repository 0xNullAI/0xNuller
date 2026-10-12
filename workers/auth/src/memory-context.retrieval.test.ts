import { afterEach, beforeEach, expect, it } from 'vitest';
import { handleMemoryContext } from './memory-context';
import { sha256Hex, type SessionEnv } from './session-domain';
import { createTestDb } from './test-helpers';

let db: ReturnType<typeof createTestDb>;
let env: SessionEnv;

type Context = {
  longTerm: Array<{ id: string }>;
  relationshipHistory: Array<{ id: string }>;
};

async function addMemory(
  id: string,
  content: string,
  updatedAt: number,
  options: { user?: string; relationship?: string; tier?: string; expiresAt?: number } = {},
) {
  await env.DB.prepare(
    `INSERT INTO personal_memories
      (user_id,id,kind,title,content,version,created_at,updated_at,scope,relationship_id,tier,state,expires_at)
     VALUES(?,?,'note','',?,1,1,?,'relationship',?,?,'active',?)`,
  )
    .bind(
      options.user ?? 'alice',
      id,
      content,
      updatedAt,
      options.relationship ?? 'r',
      options.tier ?? 'long',
      options.expiresAt ?? null,
    )
    .run();
}

async function retrieve(query: string): Promise<Context> {
  const response = await handleMemoryContext(
    new Request('https://0xnullai.com/api/auth/memory-context', {
      method: 'POST',
      headers: { Authorization: 'Bearer alice', 'X-Account-Id': 'alice' },
      body: JSON.stringify({ conversationId: 'c', query }),
    }),
    env,
    {},
  );
  expect(response?.status).toBe(200);
  return (await response!.json()) as Context;
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
  for (const [id, character] of [
    ['r', 'scene'],
    ['other', 'other-scene'],
  ]) {
    await env.DB.prepare(
      `INSERT INTO character_relationships
        (user_id,id,character_id,ai_nickname,user_preferred_name,relationship_type,notes,version,created_at,updated_at)
       VALUES('alice',?,?, '', '', '', '',1,1,1)`,
    )
      .bind(id, character)
      .run();
  }
  await env.DB.prepare(
    "INSERT INTO server_conversations(user_id,id,created_at,metadata,updated_at,mutation_id) VALUES('alice','c',1,?,1,'m')",
  )
    .bind(JSON.stringify({ promptPresetId: 'scene', relationshipId: 'r' }))
    .run();
  await addMemory('lin-interview', '我的同事小林周五要去面试。', 10);
  await addMemory('wang-interview', '我的同事小王周二要去面试。', 30);
  await addMemory('lin-birthday', '小林的生日是五月十日。', 20);
  await addMemory('wang-birthday', '小王的生日是六月十五日。', 40);
  await addMemory('peanut', '我对花生过敏。', 12);
  await addMemory('travel', '我们计划十月去京都旅行。', 14);
  await addMemory('novel', '我喜欢读科幻小说。', 18);
  await addMemory('reading', '我们约定周日一起读书。', 16, { tier: 'history' });
  await addMemory('other-secret', '小陈周三要去面试，生日是六月二十日。', 100, {
    relationship: 'other',
  });
  await addMemory('bob-secret', '小陈周四要去面试，生日是七月二十日。', 100, {
    user: 'bob',
  });
  await addMemory('expired', '小林明天去参加音乐会。', 200, { expiresAt: 1 });
  await addMemory('deleted', '小林养了一只猫。', 200);
  await env.DB.prepare(
    "UPDATE personal_memories SET deleted_at=5,content='',title='' WHERE user_id='alice' AND id='deleted'",
  ).run();
});
afterEach(() => db.close());

it('retrieves distinct Chinese people and facts without substituting another person', async () => {
  const cases: Array<[string, string | null]> = [
    ['小林的面试在星期几？', 'lin-interview'],
    ['小王的面试在星期几？', 'wang-interview'],
    ['小林的生日是哪天？', 'lin-birthday'],
    ['小王的生日是哪天？', 'wang-birthday'],
    ['小陈的面试在星期几？', null],
    ['小陈的生日是哪天？', null],
    ['小林周六面试吗？', 'lin-interview'],
    ['我对花生过敏吗？', 'peanut'],
    ['十月的京都旅行', 'travel'],
  ];
  const observed: Array<string | null> = [];
  for (const [query] of cases) {
    const context = await retrieve(query);
    observed.push(context.longTerm[0]?.id ?? null);
    expect(
      context.longTerm.map((memory) => memory.id),
      query,
    ).not.toContain('other-secret');
    expect(
      context.longTerm.map((memory) => memory.id),
      query,
    ).not.toContain('bob-secret');
    expect(
      context.longTerm.map((memory) => memory.id),
      query,
    ).not.toContain('expired');
    expect(
      context.longTerm.map((memory) => memory.id),
      query,
    ).not.toContain('deleted');
  }
  expect(observed).toEqual(cases.map(([, expected]) => expected));
  // No preceding referent for “她”: both interviews are candidates. The model
  // must ask which person the user means instead of asserting the newest fact.
  const ambiguous = await retrieve('她的面试什么时候？');
  expect(ambiguous.longTerm.map(({ id }) => id)).toEqual(
    expect.arrayContaining(['lin-interview', 'wang-interview']),
  );
  expect((await retrieve('阿姨的面试什么时候？')).longTerm).toEqual([]);
  expect((await retrieve('小朋友的面试什么时候？')).longTerm).toEqual([]);
  expect((await retrieve('小说')).longTerm[0]?.id).toBe('novel');
  expect((await retrieve('上次约定什么时候读书？')).relationshipHistory[0]?.id).toBe('reading');
});
