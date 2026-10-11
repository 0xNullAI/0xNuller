import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { handleMemoryContext } from './memory-context';
import { handleMemoryFacts } from './memory-facts';
import { stageSegmentedMemory } from './segmented-memory';
import { sha256Hex, type SessionEnv } from './session-domain';
import { createTestDb } from './test-helpers';

type Tier = 'longTerm' | 'mediumTerm' | 'relationshipHistory';
type Retrieved = Record<Tier, Array<{ id: string; content: string }>>;
type Case = {
  id: string;
  category: 'cross_session' | 'alias' | 'same_name' | 'negation' | 'correction' | 'event';
  query: string;
  tier: Tier;
  expectedTop?: string;
  required?: string[];
  expectedNone?: boolean;
};

const CASES: Case[] = [
  {
    id: 'lin-event',
    category: 'cross_session',
    query: '小林的面试是哪天？',
    tier: 'longTerm',
    expectedTop: 'lin-event',
  },
  {
    id: 'lin-activity',
    category: 'cross_session',
    query: '小林周五要做什么？',
    tier: 'longTerm',
    expectedTop: 'lin-event',
  },
  {
    id: 'lin-followup',
    category: 'cross_session',
    query: '小林面试之后该跟进什么？',
    tier: 'longTerm',
    required: ['lin-event'],
  },
  {
    id: 'lin-alias',
    category: 'alias',
    query: '林然的面试是哪天？',
    tier: 'longTerm',
    required: ['lin-alias', 'lin-event'],
  },
  {
    id: 'lin-alias-name',
    category: 'alias',
    query: '林然还叫什么？',
    tier: 'longTerm',
    expectedTop: 'lin-alias',
  },
  {
    id: 'lin-alias-reverse',
    category: 'alias',
    query: '小林还有什么名字？',
    tier: 'longTerm',
    required: ['lin-alias'],
  },
  {
    id: 'wang-event',
    category: 'cross_session',
    query: '小王面试星期几？',
    tier: 'longTerm',
    expectedTop: 'wang-event',
  },
  {
    id: 'wang-activity',
    category: 'cross_session',
    query: '小王周二准备做什么？',
    tier: 'longTerm',
    expectedTop: 'wang-event',
  },
  {
    id: 'product-zhang',
    category: 'same_name',
    query: '产品组张伟会弹吉他吗？',
    tier: 'longTerm',
    expectedTop: 'product-zhang',
  },
  {
    id: 'product-skill',
    category: 'same_name',
    query: '产品组张伟擅长什么？',
    tier: 'longTerm',
    expectedTop: 'product-zhang',
  },
  {
    id: 'finance-zhang',
    category: 'same_name',
    query: '财务组张伟会弹吉他吗？',
    tier: 'longTerm',
    expectedTop: 'finance-zhang',
  },
  {
    id: 'finance-skill',
    category: 'same_name',
    query: '财务组张伟擅长吉他吗？',
    tier: 'longTerm',
    expectedTop: 'finance-zhang',
  },
  // The bare name has two people and no single correct answer. Both facts must be available for clarification.
  {
    id: 'ambiguous-zhang',
    category: 'same_name',
    query: '张伟会弹吉他吗？',
    tier: 'longTerm',
    required: ['product-zhang', 'finance-zhang'],
  },
  {
    id: 'current-coffee',
    category: 'correction',
    query: '我现在喝咖啡吗？',
    tier: 'longTerm',
    expectedTop: 'coffee-new',
  },
  {
    id: 'coffee-change',
    category: 'correction',
    query: '我现在改喝什么？',
    tier: 'longTerm',
    expectedTop: 'coffee-new',
  },
  {
    id: 'coffee-before',
    category: 'correction',
    query: '我以前每天喝什么？',
    tier: 'longTerm',
    expectedTop: 'coffee-old',
  },
  {
    id: 'conflicting-coffee',
    category: 'correction',
    query: '我喝咖啡吗？',
    tier: 'longTerm',
    required: ['coffee-old', 'coffee-new'],
  },
  {
    id: 'peanut',
    category: 'negation',
    query: '我吃花生吗？',
    tier: 'longTerm',
    expectedTop: 'peanut',
  },
  {
    id: 'peanut-can-eat',
    category: 'negation',
    query: '我可以吃花生吗？',
    tier: 'longTerm',
    expectedTop: 'peanut',
  },
  {
    id: 'peanut-allergy',
    category: 'negation',
    query: '花生过敏这件事？',
    tier: 'longTerm',
    expectedTop: 'peanut',
  },
  {
    id: 'allergy-paraphrase',
    category: 'negation',
    query: '我的过敏原是什么？',
    tier: 'longTerm',
    required: ['peanut'],
  },
  {
    id: 'cat-negation',
    category: 'negation',
    query: '我有养猫吗？',
    tier: 'longTerm',
    expectedTop: 'no-cat',
  },
  {
    id: 'cat-inverse',
    category: 'negation',
    query: '猫是我养的吗？',
    tier: 'longTerm',
    expectedTop: 'no-cat',
  },
  {
    id: 'reading-plan',
    category: 'event',
    query: '周日读书的约定是什么？',
    tier: 'relationshipHistory',
    expectedTop: 'reading',
  },
  {
    id: 'reading-short',
    category: 'event',
    query: '周日约定做什么？',
    tier: 'relationshipHistory',
    expectedTop: 'reading',
  },
  {
    id: 'travel-paraphrase',
    category: 'event',
    query: '京都之行在哪月？',
    tier: 'longTerm',
    required: ['travel'],
  },
  {
    id: 'travel-where',
    category: 'event',
    query: '十月想去哪里？',
    tier: 'longTerm',
    expectedTop: 'travel',
  },
  {
    id: 'travel-when',
    category: 'event',
    query: '京都旅行几月？',
    tier: 'longTerm',
    expectedTop: 'travel',
  },
  {
    id: 'unknown-person',
    category: 'same_name',
    query: '小陈的面试是哪天？',
    tier: 'longTerm',
    expectedNone: true,
  },
  {
    id: 'unknown-person-2',
    category: 'same_name',
    query: '小赵的生日是哪天？',
    tier: 'longTerm',
    expectedNone: true,
  },
];

let db: ReturnType<typeof createTestDb>;
let env: SessionEnv;

async function relationship(user: string, id: string, character: string) {
  await env.DB.prepare(
    `INSERT INTO character_relationships(user_id,id,character_id,ai_nickname,user_preferred_name,
     relationship_type,notes,version,created_at,updated_at)
     VALUES(?,?,?,'','','','',1,1,1)`,
  )
    .bind(user, id, character)
    .run();
}
async function conversation(user: string, id: string, metadata: object) {
  await env.DB.prepare(
    `INSERT INTO server_conversations(user_id,id,created_at,metadata,updated_at,mutation_id)
     VALUES(?,?,1,?,1,'m')`,
  )
    .bind(user, id, JSON.stringify(metadata))
    .run();
}
async function message(
  user: string,
  conversationId: string,
  id: string,
  role: string,
  content: string,
) {
  await env.DB.prepare(
    `INSERT INTO server_conversation_messages
     (user_id,conversation_id,id,role,content,created_at,position) VALUES(?,?,?,?,?,1,1)`,
  )
    .bind(user, conversationId, id, role, content)
    .run();
}
async function memory(
  id: string,
  content: string,
  updatedAt: number,
  options: {
    user?: string;
    relationship?: string;
    tier?: 'long' | 'history';
    scope?: 'relationship' | 'account';
    sourceConversation?: string;
    sourceMessage?: string;
  } = {},
) {
  await env.DB.prepare(
    `INSERT INTO personal_memories
     (user_id,id,kind,title,content,version,created_at,updated_at,scope,relationship_id,tier,state,
      source_conversation_id,source_message_ids)
     VALUES(? ,?,'note','',?,1,1,?,?,?,?, 'active',?,?)`,
  )
    .bind(
      options.user ?? 'alice',
      id,
      content,
      updatedAt,
      options.scope ?? 'relationship',
      options.scope === 'account' ? null : (options.relationship ?? 'r'),
      options.tier ?? 'long',
      options.sourceConversation ?? null,
      JSON.stringify(options.sourceMessage ? [options.sourceMessage] : []),
    )
    .run();
}

async function read(conversationId: string, query = '', token = 'alice') {
  const response = (await handleMemoryContext(
    new Request('https://0xnullai.com/api/auth/memory-context', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'X-Account-Id': token },
      body: JSON.stringify({ conversationId, query }),
    }),
    env,
    {},
  ))!;
  return { status: response.status, body: (await response.json()) as Retrieved };
}
async function fact(path: string, method: string, body: object) {
  return handleMemoryFacts(
    new Request(`https://0xnullai.com/api/auth/${path}`, {
      method,
      headers: { Authorization: 'Bearer alice', 'X-Account-Id': 'alice' },
      body: JSON.stringify(body),
    }),
    env,
    {},
  );
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
  await relationship('alice', 'r', 'card');
  await relationship('alice', 'other', 'other-card');
  await relationship('bob', 'r', 'card');
  await conversation('alice', 'c1', { relationshipId: 'r', promptPresetId: 'card' });
  await conversation('alice', 'c2', { relationshipId: 'r', promptPresetId: 'card' });
  await conversation('alice', 'other-c', { relationshipId: 'other', promptPresetId: 'other-card' });
  await conversation('alice', 'dm-c', { conversationType: 'dm' });
  await conversation('alice', 'group-c', { conversationType: 'group' });
  await conversation('bob', 'bob-c', { relationshipId: 'r', promptPresetId: 'card' });
  await message('alice', 'c1', 'lin-source', 'user', '同事小林本周五要面试。');
  await message('alice', 'c2', 'alias-source', 'user', '小林也叫林然，我还想问她面试后的感受。');
  await message('alice', 'c2', 'assistant-guess', 'assistant', '我猜小林已经拿到工作。');
  await message('alice', 'other-c', 'other-source', 'user', '另一个角色的私人秘密。');
  await message('bob', 'bob-c', 'bob-source', 'user', 'Bob 的私人秘密。');
  await memory('lin-event', '同事小林本周五要面试。', 10, {
    sourceConversation: 'c1',
    sourceMessage: 'lin-source',
  });
  await memory('lin-alias', '小林也叫林然。', 11, {
    sourceConversation: 'c2',
    sourceMessage: 'alias-source',
  });
  await memory('wang-event', '同事小王本周二要面试。', 12);
  await memory('product-zhang', '产品组张伟擅长弹吉他。', 13);
  await memory('finance-zhang', '财务组张伟不会弹吉他。', 14);
  await memory('coffee-old', '我以前每天喝咖啡。', 15);
  await memory('coffee-new', '我现在不喝咖啡，改喝乌龙茶。', 16);
  await memory('peanut', '我对花生过敏，不吃花生。', 17);
  await memory('no-cat', '我没有养猫。', 18);
  await memory('reading', '我们约定周日一起读书。', 19, { tier: 'history' });
  await memory('travel', '十月想去京都旅行。', 20);
  await memory('other-secret', '小陈星期三面试，生日在六月。', 100, { relationship: 'other' });
  await memory('bob-secret', '小陈星期四面试，生日在七月。', 100, { user: 'bob' });
  await memory('account-only', '账号级私有事实：喜欢海盐。', 21, { scope: 'account' });
});
afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
});

it('does not turn unrelated questions into a personal fact', async () => {
  for (const query of ['我喜欢蓝莓吗？', '小陈的面试是哪天？']) {
    const result = await read('c1', query);
    expect(result.status).toBe(200);
    expect(result.body.longTerm, query).toEqual([]);
  }
  const named = await read('c1', '小王的生日是哪天？');
  expect(named.status).toBe(200);
  expect(named.body.longTerm.every(({ content }) => !content.includes('生日'))).toBe(true);
});

it('keeps reversed ownership questions anchored to the speaker across new Chinese examples', async () => {
  await memory('own-dog', '我没养狗。', 30);
  await memory('friend-dog', '我的朋友阿哲养狗。', 31);
  await memory('friend-bird', '我的朋友阿哲养鸟。', 32);
  await memory('friend-turtle', '我的朋友阿哲养乌龟。', 33);
  await memory('other-cat', '我养猫。', 34, { relationship: 'other' });
  await memory('bob-fish', '我养鱼。', 35, { user: 'bob' });
  const cases: Array<{ query: string; expected: string | null }> = [
    { query: '狗是我养的吗？', expected: 'own-dog' },
    { query: '狗是我养的？', expected: 'own-dog' },
    { query: '鸟是我养的吗？', expected: null },
    { query: '乌龟是我养的吗？', expected: null },
    { query: '鱼是我养的吗？', expected: null },
  ];
  const outcomes = [];
  for (const item of cases) {
    const result = await read('c1', item.query);
    expect(result.status).toBe(200);
    const returned = result.body.longTerm.map(({ id }) => id);
    const pass = item.expected === null ? returned.length === 0 : returned[0] === item.expected;
    outcomes.push({ ...item, returned, pass });
    expect(returned, item.query).not.toContain('other-cat');
    expect(returned, item.query).not.toContain('bob-fish');
    expect(pass, item.query).toBe(true);
  }
  console.info(`MEMORY_EVAL_OWNERSHIP ${JSON.stringify({ cases: cases.length, outcomes })}`);
});

it('reports separate same-name, negation and explicit-correction examples', async () => {
  await memory('design-chen', '设计部陈宁负责蓝桥计划。', 40);
  await memory('finance-chen', '财务部陈宁不负责蓝桥计划。', 41);
  await memory('sleep-old', '我以前凌晨三点睡觉。', 42);
  await memory('sleep-new', '我现在晚上十一点睡觉。', 43);
  const queries: Array<{ query: string; expectedTop?: string; required?: string[] }> = [
    { query: '设计部陈宁负责蓝桥计划吗？', expectedTop: 'design-chen' },
    { query: '财务部陈宁负责蓝桥计划吗？', expectedTop: 'finance-chen' },
    { query: '陈宁负责蓝桥计划吗？', required: ['design-chen', 'finance-chen'] },
    { query: '我现在几点睡觉？', expectedTop: 'sleep-new' },
    { query: '我以前几点睡觉？', expectedTop: 'sleep-old' },
  ];
  const outcomes = [];
  for (const item of queries) {
    const result = await read('c1', item.query);
    expect(result.status).toBe(200);
    const returned = result.body.longTerm.map(({ id }) => id);
    const pass = item.expectedTop
      ? returned[0] === item.expectedTop
      : item.required?.every((id) => returned.includes(id)) === true;
    outcomes.push({ ...item, returned, pass });
    expect(returned, item.query).not.toContain('other-secret');
    expect(returned, item.query).not.toContain('bob-secret');
    expect(pass, `${item.query} -> ${JSON.stringify(returned)}`).toBe(true);
  }
  expect(
    (
      await fact('memory-facts/sleep-old/supersede', 'POST', {
        version: 1,
        replacementId: 'sleep-new',
        replacementVersion: 1,
      })
    )?.status,
  ).toBe(200);
  const corrected = (await read('c1', '我现在晚上十一点睡觉吗？')).body.longTerm.map(
    ({ id }) => id,
  );
  expect(corrected).toContain('sleep-new');
  expect(corrected).not.toContain('sleep-old');
  console.info(
    `MEMORY_EVAL_ADDITIONAL ${JSON.stringify({ cases: queries.length, passed: outcomes.filter(({ pass }) => pass).length, outcomes, correctionRetiredOld: !corrected.includes('sleep-old') })}`,
  );
});

it('prints a repeatable synthetic Chinese retrieval baseline and local cost profile', async () => {
  const fetchCall = vi.fn(() => {
    throw new Error('This benchmark must stay offline');
  });
  vi.stubGlobal('fetch', fetchCall);
  const originalDb = env.DB;
  let statements = 0;
  env.DB = {
    ...originalDb,
    prepare(sql: string) {
      statements++;
      return originalDb.prepare(sql);
    },
  } as SessionEnv['DB'];
  const results: Array<{
    id: string;
    category: Case['category'];
    pass: boolean;
    returned: string[];
  }> = [];
  const timings: number[] = [];
  const statementCounts: number[] = [];
  for (const caseItem of CASES)
    for (let warmup = 0; warmup < 5; warmup++) await read('c1', caseItem.query);
  for (const caseItem of CASES) {
    let result: Awaited<ReturnType<typeof read>> | undefined;
    for (let repeat = 0; repeat < 5; repeat++) {
      statements = 0;
      const start = performance.now();
      const sample = await read('c1', caseItem.query);
      timings.push(performance.now() - start);
      statementCounts.push(statements);
      result ??= sample;
    }
    if (!result) throw new Error('memory evaluation produced no samples');
    expect(result.status, caseItem.id).toBe(200);
    const returned = result.body[caseItem.tier].map(({ id }) => id);
    const pass = caseItem.expectedNone
      ? returned.length === 0
      : caseItem.expectedTop
        ? returned[0] === caseItem.expectedTop
        : (caseItem.required?.every((id) => returned.includes(id)) ?? false);
    results.push({ id: caseItem.id, category: caseItem.category, pass, returned });
    expect(JSON.stringify(result.body), caseItem.id).not.toContain('另一个角色的私人秘密');
    expect(JSON.stringify(result.body), caseItem.id).not.toContain('Bob 的私人秘密');
    expect(JSON.stringify(result.body), caseItem.id).not.toContain('账号级私有事实');
    expect(JSON.stringify(result.body), caseItem.id).not.toContain('拿到工作');
  }
  const ordered = [...timings].sort((a, b) => a - b);
  const percentile = (fraction: number) =>
    Number(ordered[Math.ceil(fraction * ordered.length) - 1]!.toFixed(3));
  const report = {
    corpus: 'synthetic-zh-cross-session-v1',
    cases: CASES.length,
    latencySamples: timings.length,
    passed: results.filter((item) => item.pass).length,
    byCategory: Object.fromEntries(
      [...new Set(CASES.map((item) => item.category))].map((category) => {
        const subset = results.filter((item) => item.category === category);
        return [
          category,
          { passed: subset.filter((item) => item.pass).length, total: subset.length },
        ];
      }),
    ),
    outcomes: results,
    localLatencyMs: { p50: percentile(0.5), p95: percentile(0.95) },
    sqlStatementsPerRead: { min: Math.min(...statementCounts), max: Math.max(...statementCounts) },
    incrementalProviderCalls: fetchCall.mock.calls.length,
    incrementalProviderUsdPer1000Reads: 0,
    unresolvedConflictPairs: [['coffee-old', 'coffee-new']],
  };
  console.info(`MEMORY_EVAL ${JSON.stringify(report)}`);
  // Compare only unchanged questions; the old historical coffee question has no
  // answer once that fact is explicitly retired, so counting it as a miss would
  // conflate retrieval accuracy with a different product policy.
  const comparable = CASES.filter(
    ({ id }) => id !== 'coffee-before' && id !== 'conflicting-coffee',
  );
  expect(
    (
      await fact('memory-people/lin', 'PUT', {
        version: 0,
        relationshipId: 'r',
        displayName: '小林',
        aliases: ['林然'],
      })
    )?.status,
  ).toBe(201);
  for (const memoryId of ['lin-event', 'lin-alias'])
    expect(
      (
        await fact('memory-people/lin/link', 'PUT', {
          personVersion: 1,
          memoryId,
          memoryVersion: 1,
        })
      )?.status,
    ).toBe(200);
  expect(
    (
      await fact('memory-facts/coffee-old/supersede', 'POST', {
        version: 1,
        replacementId: 'coffee-new',
        replacementVersion: 1,
      })
    )?.status,
  ).toBe(200);
  const structuredTimings: number[] = [];
  const structuredStatements: number[] = [];
  const structuredOutcomes: typeof results = [];
  for (const caseItem of comparable) {
    let result: Awaited<ReturnType<typeof read>> | undefined;
    for (let repeat = 0; repeat < 5; repeat++) {
      statements = 0;
      const start = performance.now();
      const sample = await read('c1', caseItem.query);
      structuredTimings.push(performance.now() - start);
      structuredStatements.push(statements);
      result ??= sample;
    }
    if (!result) throw new Error('structured evaluation produced no samples');
    const returned = result.body[caseItem.tier].map(({ id }) => id);
    const pass = caseItem.expectedNone
      ? returned.length === 0
      : caseItem.expectedTop
        ? returned[0] === caseItem.expectedTop
        : (caseItem.required?.every((id) => returned.includes(id)) ?? false);
    structuredOutcomes.push({ id: caseItem.id, category: caseItem.category, pass, returned });
  }
  const corrected = await read('c1', '我喝咖啡吗？');
  const correctedIds = corrected.body.longTerm.map(({ id }) => id);
  expect(correctedIds).toContain('coffee-new');
  expect(correctedIds).not.toContain('coffee-old');
  const structuredOrdered = [...structuredTimings].sort((a, b) => a - b);
  const structuredReport = {
    corpus: 'synthetic-zh-cross-session-v1',
    comparableCases: comparable.length,
    baselineComparablePassed: results.filter(
      ({ id, pass }) => pass && comparable.some((item) => item.id === id),
    ).length,
    explicitIdentityAndCorrectionPassed: structuredOutcomes.filter(({ pass }) => pass).length,
    aliasBefore: results.filter(({ category, pass }) => category === 'alias' && pass).length,
    aliasAfter: structuredOutcomes.filter(({ category, pass }) => category === 'alias' && pass)
      .length,
    oldCoffeeInContext: correctedIds.includes('coffee-old'),
    localLatencyMs: {
      p50: Number(structuredOrdered[Math.ceil(0.5 * structuredOrdered.length) - 1]!.toFixed(3)),
      p95: Number(structuredOrdered[Math.ceil(0.95 * structuredOrdered.length) - 1]!.toFixed(3)),
    },
    sqlStatementsPerRead: {
      min: Math.min(...structuredStatements),
      max: Math.max(...structuredStatements),
    },
    outcomes: structuredOutcomes,
  };
  console.info(`MEMORY_EVAL_STRUCTURED ${JSON.stringify(structuredReport)}`);
  expect(fetchCall).not.toHaveBeenCalled();
});

it('keeps D1 scope/consent authoritative and propagates source edits and deletion', async () => {
  expect((await read('dm-c', '小林')).status).toBe(404);
  expect((await read('group-c', '小林')).status).toBe(404);
  expect((await read('bob-c', '小陈', 'bob')).body.longTerm.map(({ id }) => id)).toEqual([
    'bob-secret',
  ]);
  expect(JSON.stringify((await read('c1', '海盐')).body)).not.toContain('account-only');
  await env.DB.prepare(
    `INSERT INTO conversation_account_memory_access(user_id,conversation_id,enabled,version,updated_at)
     VALUES('alice','c1',1,1,1)`,
  ).run();
  expect((await read('c1', '海盐')).body.longTerm.map(({ id }) => id)).toContain('account-only');
  await env.DB.prepare(
    "UPDATE conversation_account_memory_access SET enabled=0,version=2 WHERE user_id='alice' AND conversation_id='c1'",
  ).run();
  expect(JSON.stringify((await read('c1', '海盐')).body)).not.toContain('account-only');

  const segment = (await stageSegmentedMemory(env, 'alice', 'r'))!;
  expect(segment.state).toBe('suggested');
  expect((await read('c1', '小林')).body.mediumTerm.map(({ id }) => id)).not.toContain(segment.id);
  await env.DB.prepare(
    "UPDATE personal_memories SET state='active',version=version+1 WHERE user_id='alice' AND id=?",
  )
    .bind(segment.id)
    .run();
  expect((await read('c1', '小林')).body.mediumTerm.map(({ id }) => id)).toContain(segment.id);
  await env.DB.prepare(
    "UPDATE server_conversation_messages SET content='我收回之前的说法' WHERE user_id='alice' AND conversation_id='c1' AND id='lin-source'",
  ).run();
  const afterCorrection = await read('c1', '小林');
  expect(afterCorrection.body.longTerm.map(({ id }) => id)).not.toContain('lin-event');
  expect(afterCorrection.body.mediumTerm.map(({ id }) => id)).not.toContain(segment.id);
  expect(
    await env.DB.prepare(
      'SELECT content,deleted_at FROM personal_memories WHERE user_id=? AND id=?',
    )
      .bind('alice', segment.id)
      .first(),
  ).toMatchObject({ content: '', deleted_at: expect.any(Number) });
  await env.DB.prepare(
    "DELETE FROM server_conversation_messages WHERE user_id='alice' AND conversation_id='c2' AND id='alias-source'",
  ).run();
  expect((await read('c1', '林然')).body.longTerm.map(({ id }) => id)).not.toContain('lin-alias');
});
