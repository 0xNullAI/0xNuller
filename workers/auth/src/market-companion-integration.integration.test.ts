import { afterEach, beforeEach, expect, it } from 'vitest';
import { withImportedMarketScene, type SceneLibrary } from '@0xnullai/scenes';
import { handleCharacterRelationships } from './character-relationships';
import { handleMemoryContext } from './memory-context';
import { handlePersonalMemories } from './personal-memory';
import { sha256Hex, type SessionEnv } from './session-domain';
import { createTestDb } from './test-helpers';

let db: ReturnType<typeof createTestDb>;
let env: SessionEnv;
const origin = 'https://0xnullai.com';
const character = {
  id: 'lan',
  type: 'scenario',
  name: '小岚',
  revision: 2,
  content: {
    kind: 'character',
    prompt: '你是小岚，喜欢陪伴用户读书。',
    characterCard: {
      schemaVersion: 1,
      description: '一位温和的朋友',
      personality: '',
      greeting: '',
      exampleDialogue: '',
      tags: [],
      creator: '',
      license: '',
    },
  },
};
const scene = {
  id: 'rain',
  type: 'scenario',
  name: '雨夜',
  content: { kind: 'scene', prompt: '窗外下雨，室内安静。' },
};

function request(path: string, account: string, body?: object, method = 'POST') {
  return new Request(`${origin}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${account}`,
      'X-Account-Id': account,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
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
});
afterEach(() => db.close());

it('keeps an imported character identity and its memory when an environment changes', async () => {
  const library: SceneLibrary = { scenes: [], selectedId: '', hiddenBuiltinIds: [] };
  const imported = withImportedMarketScene(library, character);
  const characterId = imported.selectedId;
  expect(imported.scenes[0]).toMatchObject({
    id: 'market-lan',
    kind: 'character',
    prompt: character.content.prompt,
    marketRevision: 2,
  });
  const withScene = withImportedMarketScene(imported, scene);
  expect(withScene.scenes.find((card) => card.id === 'market-rain')).toMatchObject({
    kind: 'scene',
    prompt: scene.content.prompt,
  });

  const ensured = await handleCharacterRelationships(
    request('/api/auth/character-relationships/ensure', 'alice', { characterId }, 'PUT'),
    env,
    {},
  );
  expect(ensured?.status).toBe(200);
  const relationship = ((await ensured!.json()) as { item: { id: string; version: number } }).item;
  expect(
    (
      await handleCharacterRelationships(
        request('/api/auth/character-relationships/ensure', 'alice', { characterId }, 'PUT'),
        env,
        {},
      )
    )?.status,
  ).toBe(200);

  await env.DB.prepare(
    'INSERT INTO server_conversations(user_id,id,created_at,metadata,updated_at,mutation_id) VALUES(?,?,1,?,1,?)',
  )
    .bind(
      'alice',
      'chat',
      JSON.stringify({
        promptPresetId: characterId,
        relationshipId: relationship.id,
        sceneId: 'market-rain',
      }),
      'create',
    )
    .run();
  await env.DB.prepare(
    'INSERT INTO server_conversation_messages(user_id,conversation_id,id,role,content,created_at,position) VALUES(?,?,?,?,?,1,1)',
  )
    .bind('alice', 'chat', 'user-1', 'user', '记住：我喜欢在雨天读书。')
    .run();

  const suggestions = await handleMemoryContext(
    request('/api/auth/memory-context/suggestions', 'alice', { conversationId: 'chat' }),
    env,
    {},
  );
  expect(suggestions?.status).toBe(200);
  const candidate = (
    (await suggestions!.json()) as { items: Array<Record<string, unknown>> }
  ).items.find((item) => item.tier === 'long')!;
  expect(candidate).toMatchObject({ state: 'suggested', relationshipId: relationship.id });
  const confirmed = await handlePersonalMemories(
    request(
      `/api/auth/personal-memories/${candidate.id}`,
      'alice',
      {
        kind: candidate.kind,
        title: candidate.title,
        content: candidate.content,
        version: candidate.version,
        scope: 'relationship',
        relationshipId: relationship.id,
        tier: candidate.tier,
        state: 'active',
      },
      'PUT',
    ),
    env,
    {},
  );
  expect(confirmed?.status).toBe(200);

  for (const sceneId of ['market-rain', '', 'market-other']) {
    await env.DB.prepare('UPDATE server_conversations SET metadata=? WHERE user_id=? AND id=?')
      .bind(
        JSON.stringify({ promptPresetId: characterId, relationshipId: relationship.id, sceneId }),
        'alice',
        'chat',
      )
      .run();
    const context = await handleMemoryContext(
      request('/api/auth/memory-context', 'alice', { conversationId: 'chat', query: '雨天读书' }),
      env,
      {},
    );
    expect(context?.status).toBe(200);
    expect(await context!.json()).toMatchObject({
      relationshipId: relationship.id,
      longTerm: [expect.objectContaining({ content: '我喜欢在雨天读书。' })],
    });
  }
  expect(
    (
      await handleMemoryContext(
        request('/api/auth/memory-context', 'bob', { conversationId: 'chat', query: '雨天读书' }),
        env,
        {},
      )
    )?.status,
  ).toBe(404);
  await env.DB.prepare('UPDATE server_conversations SET metadata=? WHERE user_id=? AND id=?')
    .bind(
      JSON.stringify({ promptPresetId: 'market-rain', relationshipId: relationship.id }),
      'alice',
      'chat',
    )
    .run();
  expect(
    (
      await handleMemoryContext(
        request('/api/auth/memory-context', 'alice', { conversationId: 'chat' }),
        env,
        {},
      )
    )?.status,
  ).toBe(404);
});
