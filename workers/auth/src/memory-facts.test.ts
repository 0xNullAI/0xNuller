import { afterEach, beforeEach, expect, it } from 'vitest';
import { handleMemoryContext } from './memory-context';
import { handleMemoryFacts } from './memory-facts';
import { handlePersonalMemories } from './personal-memory';
import worker from './index';
import { sha256Hex, type SessionEnv } from './session-domain';
import { createTestDb } from './test-helpers';

let db: ReturnType<typeof createTestDb>;
let env: SessionEnv;
async function call(path: string, method: string, body?: object, token = 'alice') {
  const request = new Request(`https://0xnullai.com/api/auth/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'X-Account-Id': token },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const response =
    (await handleMemoryFacts(request, env, {})) ??
    (await handlePersonalMemories(request, env, {})) ??
    (await handleMemoryContext(request, env, {}));
  if (!response) throw new Error('route missing');
  return response;
}
async function addMemory(id: string, content: string, relationshipId = 'r', token = 'alice') {
  return call(
    `personal-memories/${id}`,
    'PUT',
    {
      version: 0,
      kind: 'note',
      title: id,
      content,
      scope: 'relationship',
      relationshipId,
    },
    token,
  );
}
async function retrieved(query: string, conversationId = 'c', token = 'alice') {
  const response = await call('memory-context', 'POST', { conversationId, query }, token);
  return (await response.json()) as { longTerm: Array<{ id: string; content: string }> };
}

beforeEach(async () => {
  db = createTestDb();
  env = { DB: db.DB } as SessionEnv;
  for (const user of ['alice', 'bob']) {
    await env.DB.prepare(
      'INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,?,1)',
    )
      .bind(user, user, user, 'unused')
      .run();
    await env.DB.prepare(
      'INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,1,?)',
    )
      .bind(await sha256Hex(user), user, Date.now() + 60_000)
      .run();
  }
  for (const [user, id, card] of [
    ['alice', 'r', 'card'],
    ['alice', 'other', 'other-card'],
    ['bob', 'r', 'card'],
  ])
    await env.DB.prepare(
      `INSERT INTO character_relationships(user_id,id,character_id,ai_nickname,user_preferred_name,
       relationship_type,notes,version,created_at,updated_at) VALUES(?,?,?,'','','','',1,1,1)`,
    )
      .bind(user, id, card)
      .run();
  for (const [user, id, relation, card] of [
    ['alice', 'c', 'r', 'card'],
    ['alice', 'other-c', 'other', 'other-card'],
    ['bob', 'bob-c', 'r', 'card'],
  ])
    await env.DB.prepare(
      `INSERT INTO server_conversations(user_id,id,created_at,metadata,updated_at,mutation_id)
       VALUES(?,?,1,?,1,'m')`,
    )
      .bind(user, id, JSON.stringify({ relationshipId: relation, promptPresetId: card }))
      .run();
});
afterEach(() => db.close());

it('serves private person settings through the Auth Worker route', async () => {
  const response = await worker.fetch(
    new Request('https://0xnullai.com/api/auth/memory-people?relationshipId=r', {
      headers: { Authorization: 'Bearer alice', 'X-Account-Id': 'alice' },
    }),
    { ...env, ALLOWED_ORIGINS: 'https://0xnullai.com', IP_PEPPER: 'test' } as never,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ items: [] });
});

it('replaces a confirmed fact atomically and never revives the old text after the replacement is deleted', async () => {
  expect((await addMemory('coffee-old', '我每天喝咖啡。')).status).toBe(201);
  expect((await addMemory('coffee-new', '我现在不喝咖啡，改喝乌龙茶。')).status).toBe(201);
  expect((await retrieved('咖啡')).longTerm.map(({ id }) => id)).toContain('coffee-old');
  const result = await call('memory-facts/coffee-old/supersede', 'POST', {
    version: 1,
    replacementId: 'coffee-new',
    replacementVersion: 1,
  });
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ item: { supersededById: 'coffee-new', version: 2 } });
  expect((await retrieved('咖啡')).longTerm.map(({ id }) => id)).toEqual(['coffee-new']);
  expect(
    await (await call('personal-memories?scope=relationship&relationshipId=r', 'GET')).json(),
  ).toMatchObject({
    items: expect.arrayContaining([
      expect.objectContaining({
        id: 'coffee-old',
        supersededById: 'coffee-new',
        effectiveState: 'superseded',
      }),
    ]),
  });
  expect(
    (
      await call('personal-memories/coffee-old', 'PUT', {
        version: 2,
        kind: 'note',
        title: '旧事实',
        content: '我每天喝咖啡。',
        scope: 'relationship',
        relationshipId: 'r',
        state: 'active',
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call('memory-facts/coffee-old/supersede', 'POST', {
        version: 1,
        replacementId: 'coffee-new',
        replacementVersion: 1,
      })
    ).status,
  ).toBe(409);
  expect((await call('personal-memories/coffee-new', 'DELETE', { version: 1 })).status).toBe(200);
  expect((await retrieved('咖啡')).longTerm.map(({ id }) => id)).not.toContain('coffee-old');
});

it('corrects a sourced preference in one transaction without copying its source or scope', async () => {
  await env.DB.prepare(
    `INSERT INTO server_conversation_messages
     (user_id,conversation_id,id,role,content,created_at,position)
     VALUES('alice','c','coffee-source','user','我每天喝咖啡。',1,1)`,
  ).run();
  await env.DB.prepare(
    `INSERT INTO personal_memories
     (user_id,id,kind,title,content,version,created_at,updated_at,scope,relationship_id,
      tier,state,source_conversation_id,source_message_ids)
     VALUES('alice','coffee-old','preference','咖啡','我每天喝咖啡。',1,1,1,
      'relationship','r','long','active','c','["coffee-source"]')`,
  ).run();
  expect((await retrieved('咖啡')).longTerm.map(({ id }) => id)).toContain('coffee-old');
  const response = await call('memory-facts/coffee-old/correct', 'POST', {
    version: 1,
    kind: 'preference',
    title: '饮品偏好',
    content: '我现在不喝咖啡，改喝乌龙茶。',
  });
  expect(response.status).toBe(201);
  const { item } = (await response.json()) as { item: { id: string } };
  const ids = (await retrieved('咖啡')).longTerm.map(({ id }) => id);
  expect(ids).toContain(item.id);
  expect(ids).not.toContain('coffee-old');
  expect(
    await env.DB.prepare(
      `SELECT scope,relationship_id,source_conversation_id,source_message_ids,superseded_by_id
       FROM personal_memories WHERE user_id='alice' AND id=?`,
    )
      .bind(item.id)
      .first(),
  ).toEqual({
    scope: 'relationship',
    relationship_id: 'r',
    source_conversation_id: null,
    source_message_ids: '[]',
    superseded_by_id: null,
  });
  expect(
    (
      await call('memory-facts/coffee-old/correct', 'POST', {
        version: 1,
        kind: 'preference',
        title: '错误重试',
        content: '重复请求',
      })
    ).status,
  ).toBe(409);
  await env.DB.prepare(
    "DELETE FROM server_conversation_messages WHERE user_id='alice' AND conversation_id='c' AND id='coffee-source'",
  ).run();
  expect((await retrieved('咖啡')).longTerm.map(({ id }) => id)).toContain(item.id);
  expect((await call(`personal-memories/${item.id}`, 'DELETE', { version: 1 })).status).toBe(200);
  expect((await retrieved('咖啡')).longTerm.map(({ id }) => id)).not.toContain('coffee-old');
});

it('refuses cross-account, cross-relationship, suggested and stale replacement targets', async () => {
  await addMemory('old', '甲关系里的事实');
  await addMemory('other', '乙关系里的事实', 'other');
  await addMemory('bob-new', 'Bob 的事实', 'r', 'bob');
  await addMemory('new', '新的事实');
  const attempt = (replacementId: string, token = 'alice', replacementVersion = 1) =>
    call(
      `memory-facts/old/supersede`,
      'POST',
      { version: 1, replacementId, replacementVersion },
      token,
    );
  expect((await attempt('other')).status).toBe(409);
  expect((await attempt('bob-new')).status).toBe(409);
  expect((await attempt('new', 'bob')).status).toBe(409);
  expect((await attempt('new', 'alice', 2)).status).toBe(409);
  await env.DB.prepare(
    "UPDATE personal_memories SET state='suggested' WHERE user_id='alice' AND id='new'",
  ).run();
  expect((await attempt('new')).status).toBe(409);
  expect((await retrieved('事实')).longTerm.map(({ id }) => id)).toContain('old');
});

it('links explicit aliases by person ID while leaving same-name people separate', async () => {
  await addMemory('lin-event', '小林周五面试。');
  await addMemory('product', '产品组张伟会弹吉他。');
  await addMemory('finance', '财务组张伟不会弹吉他。');
  const create = (id: string, displayName: string, aliases: string[] = [], relationshipId = 'r') =>
    call(`memory-people/${id}`, 'PUT', { version: 0, relationshipId, displayName, aliases });
  expect((await create('lin', '小林', ['林然'])).status).toBe(201);
  expect((await create('zhang-product', '张伟', ['产品组张伟'])).status).toBe(201);
  expect((await create('zhang-finance', '张伟', ['财务组张伟'])).status).toBe(201);
  expect(
    (
      await call('memory-people/lin/link', 'PUT', {
        personVersion: 1,
        memoryId: 'lin-event',
        memoryVersion: 1,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call('memory-people/zhang-product/link', 'PUT', {
        personVersion: 1,
        memoryId: 'product',
        memoryVersion: 1,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call('memory-people/zhang-finance/link', 'PUT', {
        personVersion: 1,
        memoryId: 'finance',
        memoryVersion: 1,
      })
    ).status,
  ).toBe(200);
  expect((await retrieved('林然面试哪天')).longTerm.map(({ id }) => id)).toContain('lin-event');
  expect((await retrieved('张伟会弹吉他吗')).longTerm.map(({ id }) => id)).toEqual(
    expect.arrayContaining(['product', 'finance']),
  );
  expect((await retrieved('产品组张伟会弹吉他吗')).longTerm.map(({ id }) => id)).toEqual([
    'product',
  ]);
  expect((await retrieved('财务组张伟会弹吉他吗')).longTerm.map(({ id }) => id)).toEqual([
    'finance',
  ]);
  expect(
    (await retrieved('产品组张伟和财务组张伟会弹吉他吗')).longTerm.map(({ id }) => id),
  ).toEqual(expect.arrayContaining(['product', 'finance']));
  expect((await retrieved('产品组张伟和张伟会弹吉他吗')).longTerm.map(({ id }) => id)).toEqual(
    expect.arrayContaining(['product', 'finance']),
  );
  expect(
    (
      await call('memory-people/lin/link', 'PUT', {
        personVersion: 1,
        memoryId: 'product',
        memoryVersion: 1,
        userId: 'bob',
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call(
        'memory-people/lin/link',
        'PUT',
        { personVersion: 1, memoryId: 'product', memoryVersion: 1 },
        'bob',
      )
    ).status,
  ).toBe(409);
  expect((await create('other-person', '小林', [], 'other')).status).toBe(201);
  expect(
    (
      await call('memory-people/other-person/link', 'PUT', {
        personVersion: 1,
        memoryId: 'lin-event',
        memoryVersion: 2,
      })
    ).status,
  ).toBe(409);
  expect((await call('memory-people/lin', 'DELETE', { version: 1 })).status).toBe(200);
  expect((await retrieved('林然面试哪天')).longTerm.map(({ id }) => id)).not.toContain('lin-event');
  expect(
    await env.DB.prepare(
      "SELECT person_id FROM personal_memories WHERE user_id='alice' AND id='lin-event'",
    ).first(),
  ).toEqual({ person_id: null });
});

it('unlinks one fact without deleting its person or changing another account', async () => {
  await addMemory('event', '小林周五面试。');
  await call('memory-people/lin', 'PUT', {
    version: 0,
    relationshipId: 'r',
    displayName: '小林',
    aliases: ['林然'],
  });
  expect(
    (
      await call('memory-people/lin/link', 'PUT', {
        personVersion: 1,
        memoryId: 'event',
        memoryVersion: 1,
      })
    ).status,
  ).toBe(200);
  expect((await retrieved('林然面试哪天')).longTerm.map(({ id }) => id)).toContain('event');
  expect((await call('memory-facts/event/person', 'DELETE', { version: 2 }, 'bob')).status).toBe(
    409,
  );
  const unlinked = await call('memory-facts/event/person', 'DELETE', { version: 2 });
  expect(unlinked.status).toBe(200);
  expect(await unlinked.json()).toMatchObject({
    item: { id: 'event', version: 3, personId: null },
  });
  expect((await call('memory-facts/event/person', 'DELETE', { version: 2 })).status).toBe(409);
  expect((await retrieved('林然面试哪天')).longTerm.map(({ id }) => id)).not.toContain('event');
  expect(await (await call('memory-people?relationshipId=r', 'GET')).json()).toMatchObject({
    items: [expect.objectContaining({ id: 'lin', aliases: ['林然'] })],
  });
});

it('erases person aliases on relationship and account deletion', async () => {
  await call('memory-people/lin', 'PUT', {
    version: 0,
    relationshipId: 'r',
    displayName: '小林',
    aliases: ['林然'],
  });
  await env.DB.prepare(
    "UPDATE character_relationships SET deleted_at=100 WHERE user_id='alice' AND id='r'",
  ).run();
  expect(
    await env.DB.prepare(
      "SELECT display_name,aliases_json,deleted_at FROM memory_people WHERE user_id='alice' AND id='lin'",
    ).first(),
  ).toEqual({ display_name: '', aliases_json: '[]', deleted_at: 100 });
  expect(
    (
      await call('memory-people/lin', 'PUT', {
        version: 0,
        relationshipId: 'r',
        displayName: '小林',
        aliases: [],
      })
    ).status,
  ).toBe(409);
  await env.DB.prepare("DELETE FROM users WHERE id='alice'").run();
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM memory_people').first()).toEqual({
    count: 0,
  });
});
