import { afterEach, beforeEach, expect, it } from 'vitest';
import { handleMemoryContext } from './memory-context';
import { sha256Hex, type SessionEnv } from './session-domain';
import { createTestDb } from './test-helpers';

// Independent fictional Chinese cases. Keep this corpus separate from the
// original tuning fixture so regressions include false positives, not recall alone.
const CASES = [
  { query: '阿岚的画展在哪天？', expected: ['art-show'] },
  { query: '沈岚的画展在哪天？', expected: ['art-show'] },
  { query: '阿岚住在哪里？', expected: [] },
  { query: '沈岚的生日是哪天？', expected: [] },
  { query: '阿岚上周吃了什么？', expected: [] },
  { query: '阿岚的另一个名字是什么？', expected: ['alias'] },
  { query: '小许周六要做什么？', expected: ['xu-plan'] },
  { query: '小许的生日是什么时候？', expected: [] },
  { query: '我现在喝什么茶？', expected: ['tea-new'] },
  { query: '我以前喝什么茶？', expected: [] },
  { query: '我过去喝什么茶？', expected: [] },
  { query: '我现在喝什么咖啡？', expected: [] },
  { query: '我现在养什么猫？', expected: ['cat-current'] },
  { query: '小贺的画展在哪天？', expected: [] },
  { query: '我有养兔子吗？', expected: ['no-rabbit'] },
] as const;

let db: ReturnType<typeof createTestDb>;
let env: SessionEnv;

async function addMemory(id: string, content: string, relationship = 'r') {
  await env.DB.prepare(
    `INSERT INTO personal_memories
     (user_id,id,kind,title,content,version,created_at,updated_at,scope,relationship_id,tier,state)
     VALUES('alice',?,'note','',?,1,1,1,'relationship',?,'long','active')`,
  )
    .bind(id, content, relationship)
    .run();
}

async function retrieve(query: string) {
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
  return (await response!.json()) as { longTerm: Array<{ id: string; content: string }> };
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
    ['r', 'card'],
    ['other', 'other-card'],
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
    .bind(JSON.stringify({ promptPresetId: 'card', relationshipId: 'r' }))
    .run();
  await env.DB.prepare(
    `INSERT INTO memory_people(user_id,id,relationship_id,display_name,aliases_json,
      normalized_aliases_json,version,created_at,updated_at)
     VALUES('alice','lan','r','沈岚','["阿岚"]','["沈岚","阿岚"]',1,1,1)`,
  ).run();
  await addMemory('art-show', '阿岚下周三举办画展。');
  await addMemory('alias', '阿岚也叫沈岚。');
  await addMemory('xu-plan', '小许周六要去爬山。');
  await addMemory('tea-old', '我以前每天喝红茶。');
  await addMemory('tea-new', '我现在改喝绿茶。');
  await addMemory('friend-tea', '我的朋友小吴现在喝红茶。');
  await addMemory('bought-tea', '我现在给朋友买乌龙茶。');
  await addMemory('quoted-tea', '朋友说我现在喝奶茶。');
  await addMemory('unrelated-tea', '我现在看一本关于茶的书。');
  await addMemory('friend-coffee', '我的朋友小吴现在喝黑咖啡。');
  await addMemory('cat-current', '我现在养橘猫。');
  await addMemory('friend-cat', '我的朋友小吴现在养黑猫。');
  await addMemory('no-rabbit', '我没有养兔子。');
  await addMemory('other-secret', '小贺下周二举办画展。', 'other');
  await env.DB.prepare(
    "INSERT INTO personal_memories(user_id,id,kind,title,content,version,created_at,updated_at,scope,relationship_id,tier,state) VALUES('bob','bob-secret','note','','小贺下周五举办画展。',1,1,1,'relationship','r','long','active')",
  ).run();
  await env.DB.prepare(
    "UPDATE personal_memories SET person_id='lan' WHERE user_id='alice' AND id IN ('art-show','alias')",
  ).run();
  await env.DB.prepare(
    "UPDATE personal_memories SET superseded_by_id='tea-new' WHERE user_id='alice' AND id='tea-old'",
  ).run();
});
afterEach(() => db.close());

it('reports held-out alias, correction and abstention outcomes without cross-scope leakage', async () => {
  const outcomes = [];
  for (const item of CASES) {
    const result = await retrieve(item.query);
    const ids = result.longTerm.map(({ id }) => id);
    const pass = item.expected.length
      ? item.expected.every((id) => ids.includes(id))
      : ids.length === 0;
    outcomes.push({ query: item.query, expected: item.expected, ids, pass });
    expect(ids).not.toContain('other-secret');
    expect(ids).not.toContain('bob-secret');
    expect(ids).not.toContain('tea-old');
    if (item.query === '我现在喝什么茶？')
      for (const id of ['friend-tea', 'bought-tea', 'quoted-tea', 'unrelated-tea'])
        expect(ids).not.toContain(id);
    if (item.query === '我现在养什么猫？') expect(ids).not.toContain('friend-cat');
  }
  console.info(
    `MEMORY_EVAL_HELDOUT ${JSON.stringify({ passed: outcomes.filter(({ pass }) => pass).length, total: outcomes.length, outcomes })}`,
  );
  for (const outcome of outcomes) expect(outcome.pass, outcome.query).toBe(true);
});
