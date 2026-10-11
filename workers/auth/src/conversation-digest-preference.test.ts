import { afterEach, beforeEach, expect, it } from 'vitest';
import { handleConversationDigestPreference } from './conversation-digest-preference';
import { sha256Hex } from './session-domain';
import { createTestDb } from './test-helpers';
import type { AutoMemoryEnv } from './auto-memory';

let testDb: ReturnType<typeof createTestDb>;
let env: AutoMemoryEnv;
beforeEach(async () => {
  testDb = createTestDb();
  env = { DB: testDb.DB, MINIMAX_MEDIA_API_KEY: 'test-key' } as AutoMemoryEnv;
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
    "INSERT INTO character_relationships(user_id,id,character_id,ai_nickname,user_preferred_name,relationship_type,notes,version,created_at,updated_at) VALUES('alice','r','character','','','','',1,1,1)",
  ).run();
});
afterEach(() => testDb.close());

async function call(token: string, method = 'GET', body?: object) {
  const response = await handleConversationDigestPreference(
    new Request('https://0xnullai.com/api/auth/conversation-digest-preferences/r', {
      method,
      headers: { Authorization: `Bearer ${token}`, 'X-Account-Id': token },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    {},
  );
  if (!response) throw new Error('route');
  return response;
}

it('starts disabled and requires the relationship owner and a current version', async () => {
  expect(await (await call('alice')).json()).toMatchObject({
    item: { enabled: false, version: 0 },
  });
  expect((await call('bob')).status).toBe(404);
  expect((await call('alice', 'PUT', { enabled: true, version: 0 })).status).toBe(200);
  expect((await call('alice', 'PUT', { enabled: false, version: 0 })).status).toBe(409);
  expect(await (await call('alice')).json()).toMatchObject({ item: { enabled: true, version: 1 } });
});

it('deletes existing summaries when separate consent is disabled', async () => {
  await call('alice', 'PUT', { enabled: true, version: 0 });
  await env.DB.prepare(
    "INSERT INTO server_conversations(user_id,id,created_at,metadata,updated_at,mutation_id) VALUES('alice','c',1,?,1,'m')",
  )
    .bind(JSON.stringify({ promptPresetId: 'character', relationshipId: 'r' }))
    .run();
  await env.DB.prepare(
    "INSERT INTO server_conversation_messages(user_id,conversation_id,id,role,content,created_at,position) VALUES('alice','c','u','user','原文',1,0)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO conversation_digests(user_id,conversation_id,relationship_id,through_position,through_message_id,summary,version,updated_at) VALUES('alice','c','r',0,'u','摘要',1,1)",
  ).run();
  expect((await call('alice', 'PUT', { enabled: false, version: 1 })).status).toBe(200);
  expect(await env.DB.prepare('SELECT 1 FROM conversation_digests').first()).toBeNull();
});
