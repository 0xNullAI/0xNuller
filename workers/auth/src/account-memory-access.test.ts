import { afterEach, beforeEach, expect, it } from 'vitest';
import { handleAccountMemoryAccess } from './account-memory-access';
import { handleMemoryContext } from './memory-context';
import { sha256Hex, type SessionEnv } from './session-domain';
import { createTestDb } from './test-helpers';

let db: ReturnType<typeof createTestDb>;
let env: SessionEnv;
const url = 'https://0xnullai.com/api/auth/conversations/c/memory-access';
async function access(method = 'GET', body?: unknown, token = 'alice', account = token) {
  return (await handleAccountMemoryAccess(
    new Request(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'X-Account-Id': account },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
    {},
  ))!;
}
async function context() {
  return (await handleMemoryContext(
    new Request('https://0xnullai.com/api/auth/memory-context', {
      method: 'POST',
      headers: { Authorization: 'Bearer alice', 'X-Account-Id': 'alice' },
      body: JSON.stringify({ conversationId: 'c' }),
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
  await env.DB.prepare(
    `INSERT INTO character_relationships(user_id,id,character_id,ai_nickname,user_preferred_name,
      relationship_type,notes,version,created_at,updated_at) VALUES('alice','r','scene','','','','',1,1,1)`,
  ).run();
  await env.DB.prepare(
    "INSERT INTO server_conversations(user_id,id,created_at,metadata,updated_at,mutation_id) VALUES('alice','c',1,?,1,'m')",
  )
    .bind(JSON.stringify({ promptPresetId: 'scene', relationshipId: 'r' }))
    .run();
  await env.DB.prepare(
    `INSERT INTO personal_memories(user_id,id,kind,title,content,version,created_at,updated_at,scope,tier,state)
      VALUES('alice','global','note','偏好','只对获准聊天开放的账号事实',1,1,1,'account','long','active')`,
  ).run();
});
afterEach(() => db.close());

it('defaults closed, opens only with an owned CAS grant, and stops returning facts when closed', async () => {
  expect(await (await access()).json()).toMatchObject({ item: { enabled: false, version: 0 } });
  expect(JSON.stringify(await (await context()).json())).not.toContain('只对获准聊天开放');
  expect((await access('PUT', { enabled: true, version: 0 }, 'bob', 'alice')).status).toBe(403);
  expect((await access('PUT', { enabled: true, version: 0 }, 'bob', 'bob')).status).toBe(404);
  const opened = await access('PUT', { enabled: true, version: 0 });
  expect(opened.status).toBe(200);
  expect(opened.headers.get('Cache-Control')).toBe('no-store');
  expect(await opened.json()).toMatchObject({ item: { enabled: true, version: 1 } });
  expect(JSON.stringify(await (await context()).json())).toContain('只对获准聊天开放');
  expect((await access('PUT', { enabled: false, version: 0 })).status).toBe(409);
  expect((await access('PUT', { enabled: false, version: 1 })).status).toBe(200);
  expect(JSON.stringify(await (await context()).json())).not.toContain('只对获准聊天开放');
});

it('rejects deleted or unbound conversations and stale account headers', async () => {
  expect((await access('PUT', { enabled: true, version: 0 }, 'alice', 'bob')).status).toBe(403);
  await env.DB.prepare(
    "UPDATE server_conversations SET metadata='{}' WHERE user_id='alice' AND id='c'",
  ).run();
  expect((await access()).status).toBe(404);
  await env.DB.prepare(
    "UPDATE server_conversations SET metadata=?,deleted_at=5 WHERE user_id='alice' AND id='c'",
  )
    .bind(JSON.stringify({ promptPresetId: 'scene', relationshipId: 'r' }))
    .run();
  expect((await access()).status).toBe(404);
});
