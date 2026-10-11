import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readConversationDigest } from './conversation-digest';
import { runConversationDigest } from './run-conversation-digest';
import { createTestDb } from './test-helpers';
import type { AutoMemoryEnv } from './auto-memory';

const model = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('./minimax-conversation-digest', () => ({ generateConversationDigest: model.generate }));

let testDb: ReturnType<typeof createTestDb>;
let env: AutoMemoryEnv;
beforeEach(async () => {
  testDb = createTestDb();
  env = { DB: testDb.DB, MINIMAX_MEDIA_API_KEY: 'test-key' } as AutoMemoryEnv;
  model.generate.mockReset();
  model.generate.mockResolvedValue('讨论了读书计划。');
  await env.DB.prepare(
    "INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES('alice','alice','Alice','unused',1)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO character_relationships(user_id,id,character_id,ai_nickname,user_preferred_name,relationship_type,notes,version,created_at,updated_at) VALUES('alice','r','character','','','','',1,1,1)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO server_conversations(user_id,id,created_at,metadata,updated_at,mutation_id) VALUES('alice','c',1,?,1,'m')",
  )
    .bind(JSON.stringify({ promptPresetId: 'character', relationshipId: 'r' }))
    .run();
  for (let position = 0; position < 45; position++)
    await env.DB.prepare(
      'INSERT INTO server_conversation_messages(user_id,conversation_id,id,role,content,created_at,position) VALUES(?,?,?,?,?,?,?)',
    )
      .bind(
        'alice',
        'c',
        `m${position}`,
        position % 2 ? 'assistant' : 'user',
        `第 ${position} 条关于读书的聊天`,
        position,
        position,
      )
      .run();
});
afterEach(() => {
  vi.restoreAllMocks();
  testDb.close();
});

/** Change D1 state after the batch read, immediately before the final provider gate. */
function mutateBeforeProviderCheck(sql: string) {
  const prepare = env.DB.prepare.bind(env.DB);
  let changed = false;
  vi.spyOn(env.DB, 'prepare').mockImplementation((statementSql) => {
    const statement = prepare(statementSql);
    if (!statementSql.includes('AND p.version=?') || !statementSql.includes('json_each(?) source'))
      return statement;
    return new Proxy(statement, {
      get(target, property) {
        if (property !== 'bind') return Reflect.get(target, property, target);
        return (...args: unknown[]) => {
          const bound = target.bind(...args);
          return new Proxy(bound, {
            get(inner, innerProperty) {
              if (innerProperty !== 'first') return Reflect.get(inner, innerProperty, inner);
              return async <T>() => {
                if (!changed) {
                  changed = true;
                  await prepare(sql).run();
                }
                return inner.first<T>();
              };
            },
          });
        };
      },
    });
  });
}

async function optIn() {
  await env.DB.prepare(
    "INSERT INTO conversation_digest_preferences(user_id,relationship_id,enabled,version,updated_at) VALUES('alice','r',1,1,1)",
  ).run();
}

it('generates bounded older segments after opt-in and keeps the latest 20 messages verbatim', async () => {
  expect(await runConversationDigest(env, 1000)).toBe(0);
  expect(model.generate).not.toHaveBeenCalled();
  await optIn();
  expect(await runConversationDigest(env, 1000)).toBe(1);
  expect(model.generate.mock.calls[0]?.[2]).toHaveLength(16);
  expect(model.generate.mock.calls[0]?.[2][0].id).toBe('m0');
  expect((await readConversationDigest(env, 'alice', 'c', 'r'))?.throughMessageId).toBe('m15');
  expect(await runConversationDigest(env, 1060)).toBe(1);
  expect(model.generate.mock.calls[1]?.[1]).toBe('讨论了读书计划。');
  expect(model.generate.mock.calls[1]?.[2]).toHaveLength(9);
  expect((await readConversationDigest(env, 'alice', 'c', 'r'))?.throughMessageId).toBe('m24');
  expect(await runConversationDigest(env, 1120)).toBe(0);
});

it('rotates the bounded cron slot between eligible private conversations', async () => {
  await optIn();
  await env.DB.prepare(
    "INSERT INTO server_conversations(user_id,id,created_at,metadata,updated_at,mutation_id) VALUES('alice','newer',2,?,2,'n')",
  )
    .bind(JSON.stringify({ promptPresetId: 'character', relationshipId: 'r' }))
    .run();
  for (let position = 0; position < 45; position++)
    await env.DB.prepare(
      'INSERT INTO server_conversation_messages(user_id,conversation_id,id,role,content,created_at,position) VALUES(?,?,?,?,?,?,?)',
    )
      .bind(
        'alice',
        'newer',
        `n${position}`,
        position % 2 ? 'assistant' : 'user',
        '新会话',
        position,
        position,
      )
      .run();
  expect(await runConversationDigest(env, 1000)).toBe(1);
  expect((await readConversationDigest(env, 'alice', 'newer', 'r'))?.throughMessageId).toBe('n15');
  expect(await runConversationDigest(env, 1060)).toBe(1);
  expect((await readConversationDigest(env, 'alice', 'c', 'r'))?.throughMessageId).toBe('m15');
  expect(model.generate).toHaveBeenCalledTimes(2);
});

it('advances an empty digest without injecting it or charging for the same segment again', async () => {
  await optIn();
  model.generate.mockResolvedValueOnce('');
  expect(await runConversationDigest(env, 1000)).toBe(1);
  expect(await readConversationDigest(env, 'alice', 'c', 'r')).toMatchObject({
    throughMessageId: 'm15',
    summary: '',
  });
  expect(await runConversationDigest(env, 1060)).toBe(1);
  expect(model.generate.mock.calls[1]?.[1]).toBe('');
  expect(await runConversationDigest(env, 1120)).toBe(0);
  expect(model.generate).toHaveBeenCalledTimes(2);
});

it('does not save a model result after consent is revoked during generation', async () => {
  await optIn();
  model.generate.mockImplementationOnce(async () => {
    await env.DB.prepare(
      "UPDATE conversation_digest_preferences SET enabled=0 WHERE user_id='alice' AND relationship_id='r'",
    ).run();
    return '不该保存';
  });
  expect(await runConversationDigest(env, 1000)).toBe(0);
  expect(await readConversationDigest(env, 'alice', 'c', 'r')).toBeNull();
});

it('does not let an old request reuse consent after an off-on change', async () => {
  await optIn();
  model.generate.mockImplementationOnce(async () => {
    await env.DB.prepare(
      "UPDATE conversation_digest_preferences SET enabled=0,version=2 WHERE user_id='alice' AND relationship_id='r'",
    ).run();
    await env.DB.prepare(
      "UPDATE conversation_digest_preferences SET enabled=1,version=3 WHERE user_id='alice' AND relationship_id='r'",
    ).run();
    return '旧授权的结果';
  });
  expect(await runConversationDigest(env, 1000)).toBe(0);
  expect(await readConversationDigest(env, 'alice', 'c', 'r')).toBeNull();
  expect(await runConversationDigest(env, 1060)).toBe(1);
});

it('rejects a summary if its source text changes while the provider runs', async () => {
  await optIn();
  model.generate.mockImplementationOnce(async () => {
    await env.DB.prepare(
      "UPDATE server_conversation_messages SET content='用户更正' WHERE user_id='alice' AND conversation_id='c' AND id='m0'",
    ).run();
    return '旧的概述';
  });
  expect(await runConversationDigest(env, 1000)).toBe(0);
  expect(await readConversationDigest(env, 'alice', 'c', 'r')).toBeNull();
});

it('does not send a changed source message to the provider after the batch read', async () => {
  await optIn();
  mutateBeforeProviderCheck(
    "UPDATE server_conversation_messages SET content='已删除的敏感原文' WHERE user_id='alice' AND conversation_id='c' AND id='m0'",
  );
  expect(await runConversationDigest(env, 1000)).toBe(0);
  expect(model.generate).not.toHaveBeenCalled();
  expect(await readConversationDigest(env, 'alice', 'c', 'r')).toBeNull();
});

it('does not send a stale earlier digest after its source is corrected', async () => {
  await optIn();
  expect(await runConversationDigest(env, 1000)).toBe(1);
  mutateBeforeProviderCheck(
    "UPDATE server_conversation_messages SET content='更正最早的原文' WHERE user_id='alice' AND conversation_id='c' AND id='m0'",
  );
  expect(await runConversationDigest(env, 1060)).toBe(0);
  expect(model.generate).toHaveBeenCalledTimes(1);
  expect(await readConversationDigest(env, 'alice', 'c', 'r')).toBeNull();
});

it('backs off after provider failure without advancing the source cursor', async () => {
  await optIn();
  model.generate.mockRejectedValueOnce(new Error('provider'));
  expect(await runConversationDigest(env, 1000)).toBe(0);
  expect(await runConversationDigest(env, 1000)).toBe(0);
  expect(model.generate).toHaveBeenCalledTimes(1);
  expect(await runConversationDigest(env, 1061_000)).toBe(1);
  expect((await readConversationDigest(env, 'alice', 'c', 'r'))?.throughMessageId).toBe('m15');
});
