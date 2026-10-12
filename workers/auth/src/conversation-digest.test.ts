import { afterEach, beforeEach, expect, it } from 'vitest';
import { readConversationDigest, saveConversationDigest } from './conversation-digest';
import { createTestDb } from './test-helpers';
import type { SessionEnv } from './session-domain';

let testDb: ReturnType<typeof createTestDb>;
let env: SessionEnv;
beforeEach(async () => {
  testDb = createTestDb();
  env = { DB: testDb.DB } as SessionEnv;
  await env.DB.prepare(
    "INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES('alice','alice','Alice','unused',1)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO character_relationships(user_id,id,character_id,ai_nickname,user_preferred_name,relationship_type,notes,version,created_at,updated_at) VALUES('alice','r','character','','','','',1,1,1)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO conversation_digest_preferences(user_id,relationship_id,enabled,version,updated_at) VALUES('alice','r',1,1,1)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO server_conversations(user_id,id,created_at,metadata,updated_at,mutation_id) VALUES('alice','c',1,?,1,'m')",
  )
    .bind(JSON.stringify({ promptPresetId: 'character', relationshipId: 'r' }))
    .run();
  await env.DB.prepare(
    "INSERT INTO server_conversation_messages(user_id,conversation_id,id,role,content,created_at,position) VALUES('alice','c','u1','user','原文',1,0)",
  ).run();
});
afterEach(() => testDb.close());

const input = () => ({
  userId: 'alice',
  conversationId: 'c',
  relationshipId: 'r',
  expectedRevision: 1,
  expectedVersion: 0,
  throughPosition: 0,
  throughMessageId: 'u1',
  summary: '旧段概述',
  now: 2,
  sourceChecks: [{ id: 'u1', role: 'user' as const, content: '原文', position: 0 }],
});

it('requires exact ownership, relationship, revision and source cursor', async () => {
  for (const change of [
    { userId: 'bob' },
    { relationshipId: 'other' },
    { expectedRevision: 2 },
    { throughMessageId: 'missing' },
    { throughPosition: 1 },
    { expectedVersion: 1 },
    { sourceChecks: [{ id: 'u1', role: 'user' as const, content: '旧原文', position: 0 }] },
  ])
    expect(await saveConversationDigest(env, { ...input(), ...change })).toBe(false);
  expect(await saveConversationDigest(env, input())).toBe(true);
  expect(await readConversationDigest(env, 'alice', 'c', 'r')).toMatchObject({
    summary: '旧段概述',
  });
  expect(await readConversationDigest(env, 'bob', 'c', 'r')).toBeNull();
  expect(await readConversationDigest(env, 'alice', 'c', 'other')).toBeNull();
  expect(await saveConversationDigest(env, input())).toBe(false);
});

it('invalidates the digest when source text changes or the relationship is removed', async () => {
  expect(await saveConversationDigest(env, input())).toBe(true);
  await env.DB.prepare(
    "UPDATE server_conversation_messages SET content='改过的原文' WHERE user_id='alice' AND conversation_id='c' AND id='u1'",
  ).run();
  expect(await readConversationDigest(env, 'alice', 'c', 'r')).toBeNull();
  expect(
    await saveConversationDigest(env, {
      ...input(),
      sourceChecks: [{ id: 'u1', role: 'user', content: '改过的原文', position: 0 }],
    }),
  ).toBe(true);
  await env.DB.prepare(
    "UPDATE character_relationships SET deleted_at=3 WHERE user_id='alice' AND id='r'",
  ).run();
  expect(await readConversationDigest(env, 'alice', 'c', 'r')).toBeNull();
});

it('keeps a scene change but revokes a digest after character identity changes', async () => {
  expect(await saveConversationDigest(env, input())).toBe(true);
  await env.DB.prepare(
    "UPDATE server_conversations SET metadata=? WHERE user_id='alice' AND id='c'",
  )
    .bind(JSON.stringify({ promptPresetId: 'character', relationshipId: 'r', sceneId: 'park' }))
    .run();
  expect(await readConversationDigest(env, 'alice', 'c', 'r')).not.toBeNull();
  await env.DB.prepare(
    "UPDATE server_conversations SET metadata=? WHERE user_id='alice' AND id='c'",
  )
    .bind(JSON.stringify({ promptPresetId: 'other', relationshipId: 'r' }))
    .run();
  await env.DB.prepare(
    "UPDATE server_conversations SET metadata=? WHERE user_id='alice' AND id='c'",
  )
    .bind(JSON.stringify({ promptPresetId: 'character', relationshipId: 'r' }))
    .run();
  expect(await readConversationDigest(env, 'alice', 'c', 'r')).toBeNull();
});
