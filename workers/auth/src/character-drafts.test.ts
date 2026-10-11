import { afterEach, beforeEach, expect, it } from 'vitest';
import { emptyCharacterCard } from '@0xnullai/scenes/character-card';
import { handleCharacterDrafts } from './character-drafts';
import { sha256Hex, type SessionEnv } from './session-domain';
import { createTestDb } from './test-helpers';

let db: ReturnType<typeof createTestDb>;
let env: SessionEnv;
const draft = {
  name: '小岚',
  prompt: '陪伴朋友',
  description: '',
  icon: '🎭',
  tags: [],
  card: emptyCharacterCard(),
};

beforeEach(async () => {
  db = createTestDb();
  env = { DB: db.DB } as SessionEnv;
  for (const id of ['alice', 'bob']) {
    await env.DB.prepare(
      'INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,?,?)',
    )
      .bind(id, id, id, 'unused', 1)
      .run();
    await env.DB.prepare(
      'INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)',
    )
      .bind(await sha256Hex(id), id, 1, Date.now() + 60_000)
      .run();
  }
});
afterEach(() => db.close());

async function call(
  key: string,
  method: string,
  token = 'alice',
  payload?: unknown,
  revision?: number,
) {
  const response = await handleCharacterDrafts(
    new Request(
      `https://0xnullai.com/api/auth/character-drafts/${key}${revision ? `?revision=${revision}` : ''}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Account-Id': token,
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      },
    ),
    env,
    {},
  );
  if (!response) throw new Error('draft route not matched');
  return response;
}

it('stores, isolates and version-checks online drafts, then cascades on account deletion', async () => {
  expect(
    (
      await call('new', 'PUT', 'alice', {
        expectedRevision: 0,
        draft: { ...draft, privateMemory: '秘密' },
      })
    ).status,
  ).toBe(200);
  const fetched = await call('new', 'GET');
  expect(fetched.headers.get('Cache-Control')).toBe('private, no-store');
  expect(await fetched.json()).toMatchObject({ revision: 1, draft, accountId: 'alice' });
  expect(JSON.stringify(await (await call('new', 'GET')).json())).not.toContain('秘密');
  expect(await (await call('new', 'GET', 'bob')).json()).toMatchObject({
    draft: null,
    accountId: 'bob',
  });
  expect((await call('new', 'PUT', 'alice', { expectedRevision: 0, draft })).status).toBe(409);
  expect((await call('new', 'PUT', 'alice', { expectedRevision: 1, draft })).status).toBe(200);
  expect((await call('new', 'DELETE', 'alice', undefined, 1)).status).toBe(409);
  await env.DB.prepare('DELETE FROM users WHERE id=?').bind('alice').run();
  expect(
    await env.DB.prepare('SELECT 1 FROM character_drafts WHERE user_id=?').bind('alice').first(),
  ).toBeNull();
});

it('requires a verified ownership claim for an existing public character draft', async () => {
  expect((await call('card-1', 'PUT', 'alice', { expectedRevision: 0, draft })).status).toBe(403);
  await env.DB.prepare(
    'INSERT INTO market_claims(item_id,user_id,claimed_at,verified_at) VALUES(?,?,?,?)',
  )
    .bind('card-1', 'alice', 1, 1)
    .run();
  expect((await call('card-1', 'PUT', 'alice', { expectedRevision: 0, draft })).status).toBe(200);
  expect((await call('card-1', 'GET', 'bob')).status).toBe(200);
  expect(await (await call('card-1', 'GET', 'bob')).json()).toMatchObject({ draft: null });
});

it('round-trips only an owner-bound container id in the private online draft', async () => {
  const sourceFileId = 'b35e4030-6451-4e94-944b-99672e98a90f';
  const checked: Request[] = [];
  env.MARKET = {
    fetch: async (request: Request) => {
      checked.push(request);
      return new Response(null, {
        status: request.headers.get('X-Account-Id') === 'alice' ? 204 : 404,
      });
    },
  } as Fetcher;
  const sourceArchive = {
    format: 'ccv3',
    raw: { spec: 'chara_card_v3', spec_version: '3.0', data: { name: '小岚' } },
  };
  const withContainer = { ...draft, sourceArchive, sourceFileId, sourceFileName: '角色.charx' };
  expect(
    (await call('new', 'PUT', 'alice', { expectedRevision: 0, draft: withContainer })).status,
  ).toBe(200);
  expect(checked).toHaveLength(1);
  expect(checked[0]?.method).toBe('HEAD');
  expect(checked[0]?.url).toBe(
    `https://market.internal/api/items/character-container-drafts/${sourceFileId}/content`,
  );
  expect(checked[0]?.headers.get('Authorization')).toBe('Bearer alice');
  const restored = await (await call('new', 'GET', 'alice')).json();
  expect(restored).toMatchObject({ draft: withContainer, revision: 1 });
  expect(JSON.stringify(restored)).not.toContain('application/zip');
  expect(await (await call('new', 'GET', 'bob')).json()).toMatchObject({ draft: null });
  expect(
    (await call('new', 'PUT', 'bob', { expectedRevision: 0, draft: withContainer })).status,
  ).toBe(400);
  expect(
    (
      await call('new', 'PUT', 'alice', {
        expectedRevision: 1,
        draft: { ...withContainer, sourceFileName: '../private' },
      })
    ).status,
  ).toBe(400);
});

it('fails closed when a container owner cannot be verified', async () => {
  const sourceArchive = {
    format: 'ccv3',
    raw: { spec: 'chara_card_v3', spec_version: '3.0', data: { name: '小岚' } },
  };
  const withContainer = {
    ...draft,
    sourceArchive,
    sourceFileId: 'b35e4030-6451-4e94-944b-99672e98a90f',
    sourceFileName: '角色.charx',
  };
  expect(
    (await call('new', 'PUT', 'alice', { expectedRevision: 0, draft: withContainer })).status,
  ).toBe(503);
  env.MARKET = { fetch: async () => new Response(null, { status: 404 }) } as unknown as Fetcher;
  expect(
    (await call('new', 'PUT', 'alice', { expectedRevision: 0, draft: withContainer })).status,
  ).toBe(400);
  expect(await (await call('new', 'GET', 'alice')).json()).toMatchObject({ draft: null });
  expect((await call('new', 'PUT', 'alice', { expectedRevision: 0, draft })).status).toBe(200);
});

it('keeps a new scene draft separate from a new character draft without an ownership claim', async () => {
  expect((await call('new-scene', 'PUT', 'alice', { expectedRevision: 0, draft })).status).toBe(
    200,
  );
  expect(await (await call('new-scene', 'GET')).json()).toMatchObject({ revision: 1, draft });
  expect(await (await call('new', 'GET')).json()).toMatchObject({ draft: null });
});
