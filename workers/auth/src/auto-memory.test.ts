import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleAutoMemory, runAutoMemory, type AutoMemoryEnv } from './auto-memory';
import { parseModelMemories } from './minimax-memory';
import { sha256Hex } from './session-domain';
import { createTestDb } from './test-helpers';

let db: ReturnType<typeof createTestDb>;
let env: AutoMemoryEnv;
const now = Date.now();
const sourceText = '我喜欢喝乌龙茶，以后可以叫我小高。';

function request(method = 'GET', body?: unknown, token = 'alice', account = token) {
  return new Request('https://0xnullai.com/api/auth/auto-memory/rel', {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Account-Id': account,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function call(method = 'GET', body?: unknown, token?: string, account?: string) {
  return (await handleAutoMemory(request(method, body, token, account), env, {}))!;
}
async function queueCount() {
  return (
    await env.DB.prepare('SELECT COUNT(*) AS n FROM memory_extraction_jobs WHERE user_id=?')
      .bind('alice')
      .first<{ n: number }>()
  )?.n;
}

beforeEach(async () => {
  db = createTestDb();
  env = { DB: db.DB, MINIMAX_MEDIA_API_KEY: 'test-key' } as AutoMemoryEnv;
  for (const id of ['alice', 'bob']) {
    await env.DB.prepare(
      'INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,?,?)',
    )
      .bind(id, id, id, 'unused', now)
      .run();
    await env.DB.prepare(
      'INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)',
    )
      .bind(await sha256Hex(id), id, now, now + 600_000)
      .run();
    await env.DB.prepare(
      `INSERT INTO character_relationships(user_id,id,character_id,ai_nickname,user_preferred_name,
       relationship_type,notes,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,?,?)`,
    )
      .bind(id, 'rel', 'character', '', '', '', '', now, now)
      .run();
  }
  await env.DB.prepare(
    `INSERT INTO server_conversations(user_id,id,created_at,metadata,revision,updated_at,mutation_id)
     VALUES(?,?,?,?,1,?,?)`,
  )
    .bind(
      'alice',
      'conversation',
      now,
      JSON.stringify({ relationshipId: 'rel', promptPresetId: 'character' }),
      now,
      'mutation',
    )
    .run();
  await env.DB.prepare(
    `INSERT INTO server_conversation_messages(user_id,conversation_id,id,role,content,created_at,position)
     VALUES(?,?,?,?,?,?,?)`,
  )
    .bind('alice', 'conversation', 'user-message', 'user', sourceText, now, 0)
    .run();
});
afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
});

describe('opt-in private auto memory', () => {
  it('returns only this relationship’s queue counts without exposing source messages', async () => {
    await call('PUT', { enabled: true, version: 0 });
    await env.DB.prepare(
      `UPDATE memory_extraction_jobs SET attempts=2,last_error='provider_unavailable'
       WHERE user_id='alice' AND conversation_id='conversation'`,
    ).run();
    const response = await call();
    expect(await response.json()).toMatchObject({
      progress: { queued: 1, retrying: 1, paused: 0 },
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await env.DB.prepare(
      `UPDATE memory_extraction_jobs SET attempts=5 WHERE user_id='alice' AND conversation_id='conversation'`,
    ).run();
    expect(await (await call()).json()).toMatchObject({
      progress: { queued: 1, retrying: 0, paused: 1 },
    });
    expect(await (await call('GET', undefined, 'bob', 'bob')).json()).toMatchObject({
      progress: { queued: 0, retrying: 0, paused: 0 },
    });
  });
  it('defaults off, requires ownership and a configured provider', async () => {
    expect(await (await call()).json()).toMatchObject({
      item: { enabled: false, version: 0 },
      available: true,
    });
    expect(await queueCount()).toBe(0);
    expect((await call('PUT', { enabled: true, version: 0 }, 'bob', 'alice')).status).toBe(403);
    env.MINIMAX_MEDIA_API_KEY = undefined;
    expect((await call('PUT', { enabled: true, version: 0 })).status).toBe(503);
    expect(await queueCount()).toBe(0);
  });

  it('queues existing user messages only after consent, stages a reviewable candidate and stops on opt-out', async () => {
    const enabled = await call('PUT', { enabled: true, version: 0 });
    expect(enabled.status).toBe(200);
    expect(enabled.headers.get('Cache-Control')).toBe('no-store');
    expect(await queueCount()).toBe(1);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  items: [
                    {
                      kind: 'preference',
                      tier: 'long',
                      title: '喜欢乌龙茶',
                      content: '用户喜欢喝乌龙茶',
                      sourceId: 'user-message',
                      evidence: '我喜欢喝乌龙茶',
                    },
                  ],
                }),
              },
            },
          ],
        }),
      ),
    );
    expect(await runAutoMemory(env, now + 60_000)).toBe(1);
    const memory = await env.DB.prepare(
      'SELECT state,scope,relationship_id,tier,content,source_message_ids FROM personal_memories WHERE user_id=?',
    )
      .bind('alice')
      .first<{
        state: string;
        scope: string;
        relationship_id: string;
        tier: string;
        content: string;
        source_message_ids: string;
      }>();
    expect(memory).toMatchObject({
      state: 'suggested',
      scope: 'relationship',
      relationship_id: 'rel',
      tier: 'long',
      content: '我喜欢喝乌龙茶',
      source_message_ids: '["user-message"]',
    });
    expect(await queueCount()).toBe(0);
    expect((await call('PUT', { enabled: false, version: 1 })).status).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM memory_extraction_progress WHERE user_id='alice'",
      ).first(),
    ).toEqual({ n: 0 });
    await env.DB.prepare(
      `INSERT INTO server_conversation_messages(user_id,conversation_id,id,role,content,created_at,position)
       VALUES(?,?,?,?,?,?,?)`,
    )
      .bind('alice', 'conversation', 'later', 'user', '请记得今天的对话', now + 1, 1)
      .run();
    expect(await queueCount()).toBe(0);
  });

  it('does not turn camera observations into user memories, including after a source changes during extraction', async () => {
    await env.DB.prepare(
      `INSERT INTO server_conversation_messages
       (user_id,conversation_id,id,role,content,created_at,position,kind)
       VALUES('alice','conversation','camera','user','镜头里有一只狗',?,1,'camera_observation')`,
    )
      .bind(now + 1)
      .run();
    await call('PUT', { enabled: true, version: 0 });
    const sent: string[][] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = JSON.parse(String((init as RequestInit).body)) as {
          messages: Array<{ content: string }>;
        };
        sent.push(
          (JSON.parse(body.messages[1]!.content) as Array<{ id: string }>).map((item) => item.id),
        );
        await env.DB.prepare(
          `UPDATE server_conversation_messages SET kind='camera_observation'
         WHERE user_id='alice' AND conversation_id='conversation' AND id='user-message'`,
        ).run();
        return Response.json({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  items: [
                    {
                      kind: 'preference',
                      tier: 'long',
                      title: '喜欢乌龙茶',
                      content: '用户喜欢喝乌龙茶',
                      sourceId: 'user-message',
                      evidence: '我喜欢喝乌龙茶',
                    },
                  ],
                }),
              },
            },
          ],
        });
      }),
    );
    expect(await runAutoMemory(env, now + 60_000)).toBe(1);
    expect(sent).toEqual([['user-message']]);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM personal_memories').first()).toEqual({
      n: 0,
    });
  });

  it('does not call the provider for a camera-only extraction job', async () => {
    await env.DB.prepare(
      `UPDATE server_conversation_messages SET kind='camera_observation'
       WHERE user_id='alice' AND conversation_id='conversation' AND id='user-message'`,
    ).run();
    await call('PUT', { enabled: true, version: 0 });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await runAutoMemory(env, now + 60_000)).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await queueCount()).toBe(0);
  });

  it('queues older relationship conversations beyond the former twenty-chat limit', async () => {
    const statements = Array.from({ length: 21 }, (_, index) => {
      const id = `older-${index}`;
      return [
        env.DB.prepare(
          `INSERT INTO server_conversations(user_id,id,created_at,metadata,revision,updated_at,mutation_id)
           VALUES(?,?,?,?,1,?,?)`,
        ).bind(
          'alice',
          id,
          now - index - 1,
          JSON.stringify({ relationshipId: 'rel', promptPresetId: 'character' }),
          now - index - 1,
          `mutation-${index}`,
        ),
        env.DB.prepare(
          `INSERT INTO server_conversation_messages(user_id,conversation_id,id,role,content,created_at,position)
           VALUES(?,?,?,?,?,?,0)`,
        ).bind('alice', id, `message-${index}`, 'user', `第 ${index} 段旧聊天`, now - index - 1),
      ];
    }).flat();
    await env.DB.batch(statements);
    expect(await queueCount()).toBe(0);
    expect((await call('PUT', { enabled: true, version: 0 })).status).toBe(200);
    expect(await queueCount()).toBe(22);
    expect(
      await env.DB.prepare(
        `SELECT 1 FROM memory_extraction_jobs WHERE user_id='alice' AND conversation_id='older-20'`,
      ).first(),
    ).toEqual({ 1: 1 });
  });

  it('processes every eligible message in bounded ordered batches after consent', async () => {
    const inserts = Array.from({ length: 20 }, (_, index) =>
      env.DB.prepare(
        `INSERT INTO server_conversation_messages
         (user_id,conversation_id,id,role,content,created_at,position)
         VALUES('alice','conversation',?,'user',?, ?, ?)`,
      ).bind(`later-${index}`, `我分享了第 ${index} 件重要的事。`, now + index + 1, index + 1),
    );
    await env.DB.batch(inserts);
    await call('PUT', { enabled: true, version: 0 });
    const sent: string[][] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = JSON.parse(String((init as RequestInit).body)) as {
          messages: Array<{ content: string }>;
        };
        sent.push(
          (JSON.parse(body.messages[1]!.content) as Array<{ id: string }>).map((m) => m.id),
        );
        return Response.json({
          choices: [{ finish_reason: 'stop', message: { content: '{"items":[]}' } }],
        });
      }),
    );
    expect(await runAutoMemory(env, now + 60_000)).toBe(1);
    expect(await queueCount()).toBe(1);
    expect(await runAutoMemory(env, now + 121_000)).toBe(1);
    expect(await queueCount()).toBe(0);
    expect(sent.map((batch) => batch.length)).toEqual([16, 5]);
    expect(sent.flat()).toEqual([
      'user-message',
      ...Array.from({ length: 20 }, (_, i) => `later-${i}`),
    ]);
  });

  it('skips a batch that keeps failing instead of blocking later messages forever', async () => {
    await env.DB.batch(
      Array.from({ length: 20 }, (_, index) =>
        env.DB.prepare(
          `INSERT INTO server_conversation_messages
         (user_id,conversation_id,id,role,content,created_at,position)
         VALUES('alice','conversation',?,'user',?, ?, ?)`,
        ).bind(`later-${index}`, `我分享了第 ${index} 件重要的事。`, now + index + 1, index + 1),
      ),
    );
    await call('PUT', { enabled: true, version: 0 });
    const sent: string[][] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = JSON.parse(String((init as RequestInit).body)) as {
          messages: Array<{ content: string }>;
        };
        const ids = (JSON.parse(body.messages[1]!.content) as Array<{ id: string }>).map(
          (m) => m.id,
        );
        sent.push(ids);
        // The first batch always produces output that cannot be parsed.
        const content = ids[0] === 'user-message' ? 'not json' : '{"items":[]}';
        return Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] });
      }),
    );
    let at = now + 60_000;
    for (let run = 0; run < 12 && (await queueCount()); run += 1) {
      await runAutoMemory(env, at);
      at += 24 * 3600_000;
    }
    expect(await queueCount()).toBe(0);
    expect(sent.filter((batch) => batch[0] === 'user-message')).toHaveLength(5);
    expect(sent.at(-1)).toEqual(['later-15', 'later-16', 'later-17', 'later-18', 'later-19']);
  });

  it('rewinds extraction after a user corrects an already processed message', async () => {
    await call('PUT', { enabled: true, version: 0 });
    const sent: string[][] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = JSON.parse(String((init as RequestInit).body)) as {
          messages: Array<{ content: string }>;
        };
        sent.push(
          (JSON.parse(body.messages[1]!.content) as Array<{ content: string }>).map(
            (m) => m.content,
          ),
        );
        return Response.json({
          choices: [{ finish_reason: 'stop', message: { content: '{"items":[]}' } }],
        });
      }),
    );
    await runAutoMemory(env, now + 60_000);
    await env.DB.prepare(
      `UPDATE server_conversation_messages SET content='我现在喜欢红茶。'
       WHERE user_id='alice' AND conversation_id='conversation' AND id='user-message'`,
    ).run();
    expect(await queueCount()).toBe(1);
    await runAutoMemory(env, Date.now() + 60_000);
    expect(sent).toEqual([[sourceText], ['我现在喜欢红茶。']]);
  });

  it('rejects a candidate if its source changes while the provider is running', async () => {
    await call('PUT', { enabled: true, version: 0 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await env.DB.prepare(
          `UPDATE server_conversation_messages SET content=?
           WHERE user_id=? AND conversation_id=? AND id=?`,
        )
          .bind('这条消息已修改', 'alice', 'conversation', 'user-message')
          .run();
        return Response.json({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  items: [
                    {
                      kind: 'preference',
                      tier: 'long',
                      title: '喜欢乌龙茶',
                      content: '用户喜欢喝乌龙茶',
                      sourceId: 'user-message',
                      evidence: '我喜欢喝乌龙茶',
                    },
                  ],
                }),
              },
            },
          ],
        });
      }),
    );
    await runAutoMemory(env, now + 60_000);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM personal_memories').first<{
      n: number;
    }>();
    expect(count?.n).toBe(0);
    expect(await queueCount()).toBe(1);
  });

  it('does not send source text if the owner opts out while the queued messages are read', async () => {
    await call('PUT', { enabled: true, version: 0 });
    const originalDb = env.DB;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    env.DB = {
      prepare(sql: string) {
        const statement = originalDb.prepare(sql);
        if (!sql.includes('SELECT id,content,position FROM server_conversation_messages'))
          return statement;
        return {
          bind(...args: unknown[]) {
            const bound = statement.bind(...args);
            return {
              async all() {
                const rows = await bound.all();
                await originalDb
                  .prepare(
                    "UPDATE relationship_memory_preferences SET enabled=0,version=version+1 WHERE user_id='alice' AND relationship_id='rel'",
                  )
                  .run();
                return rows;
              },
            };
          },
        };
      },
    } as AutoMemoryEnv['DB'];
    await runAutoMemory(env, now + 60_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM personal_memories').first()).toEqual({
      n: 0,
    });
  });

  it('does not send private text to the provider when the memory quota is already full', async () => {
    await call('PUT', { enabled: true, version: 0 });
    const inserts = Array.from({ length: 200 }, (_, index) =>
      env.DB.prepare(
        `INSERT INTO personal_memories(user_id,id,kind,title,content,version,created_at,updated_at)
         VALUES('alice',?,'note','已有记忆','已保存',1,1,1)`,
      ).bind(`existing-${index}`),
    );
    await env.DB.batch(inserts);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await runAutoMemory(env, now + 60_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires exact quoted evidence from the referenced user message', () => {
    expect(
      parseModelMemories(
        JSON.stringify({
          items: [
            {
              kind: 'person',
              tier: 'long',
              title: '虚构人物',
              content: '助手推测的人物',
              sourceId: 'unknown',
              evidence: '我喜欢喝乌龙茶',
            },
          ],
        }),
        [{ id: 'user-message', content: sourceText }],
      ),
    ).toEqual([]);
  });

  it('never persists a model paraphrase that contradicts its cited user quote', () => {
    expect(
      parseModelMemories(
        JSON.stringify({
          items: [
            {
              kind: 'preference',
              tier: 'long',
              title: '喜欢猫',
              content: '用户喜欢猫',
              sourceId: 'message',
              evidence: '我不喜欢猫',
            },
          ],
        }),
        [{ id: 'message', content: '我不喜欢猫，别再推荐养猫了。' }],
      )[0],
    ).toMatchObject({ title: '我不喜欢猫', content: '我不喜欢猫' });
  });
});
