/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { handleDiscovery, recommendItems } from './discovery';
import { handleDiscoveryFeedback } from './discovery-feedback';
import type { MarketItem } from '../shared/schema';
const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
function setup() {
  const sql = new DatabaseSync(':memory:');
  databases.push(sql);
  sql.exec(readFileSync(join(import.meta.dirname, '../../migrations/0000_init.sql'), 'utf8'));
  sql.exec(
    readFileSync(join(import.meta.dirname, '../../migrations/0005_item_favorites.sql'), 'utf8'),
  );
  sql.exec(
    readFileSync(join(import.meta.dirname, '../../migrations/0006_creator_follows.sql'), 'utf8'),
  );
  sql.exec(
    readFileSync(join(import.meta.dirname, '../../migrations/0007_character_versions.sql'), 'utf8'),
  );
  sql.exec(
    readFileSync(
      join(import.meta.dirname, '../../migrations/0011_character_discovery_feedback.sql'),
      'utf8',
    ),
  );
  sql.exec(
    `INSERT INTO items(id,type,name,content,created_at,hidden,tags) VALUES ('visible','scenario','公开','{}',1,0,'自然'),('hidden','scenario','隐藏','{}',2,1,'自然')`,
  );
  function prepare(query: string, args: unknown[] = []) {
    return {
      bind: (...values: unknown[]) => prepare(query, values),
      first: async () => sql.prepare(query).get(...(args as never[])) ?? null,
      all: async () => ({ results: sql.prepare(query).all(...(args as never[])) }),
      run: async () => sql.prepare(query).run(...(args as never[])),
    };
  }
  const env = {
    DB: { prepare } as unknown as D1Database,
    AUTH: {
      marketAccountIdentity: async (): Promise<{ id: string } | null> => ({ id: 'user' }),
    },
  };
  const request = (path: string, method = 'GET', account = 'user') =>
    new Request(`https://market.test/api/items/${path}`, {
      method,
      headers: { 'X-Account-Id': account },
    });
  return { sql, env, request };
}
it('persists idempotent account-owned favorites and excludes hidden content', async () => {
  const { sql, env, request } = setup();
  expect((await handleDiscovery(request('visible/favorite', 'PUT'), env))?.status).toBe(200);
  expect((await handleDiscovery(request('visible/favorite', 'PUT'), env))?.status).toBe(200);
  expect(sql.prepare('SELECT COUNT(*) AS n FROM item_favorites').get()?.n).toBe(1);
  expect((await handleDiscovery(request('hidden/favorite', 'PUT'), env))?.status).toBe(404);
  const result = await handleDiscovery(request('discovery?mode=favorites'), env);
  expect(result?.headers.get('Cache-Control')).toContain('no-store');
  expect(((await result?.json()) as { items: MarketItem[] }).items.map((item) => item.id)).toEqual([
    'visible',
  ]);
  sql.exec("UPDATE items SET hidden=1 WHERE id='visible'");
  expect(
    (
      (await (await handleDiscovery(request('discovery?mode=favorites'), env))?.json()) as {
        items: MarketItem[];
      }
    ).items,
  ).toEqual([]);
  expect((await handleDiscovery(request('visible/favorite', 'DELETE'), env))?.status).toBe(200);
});
it('retains verified creator identity in the favorites tab, separate from editable signature', async () => {
  const { sql, env, request } = setup();
  sql.exec("UPDATE items SET author='somebody-else' WHERE id='visible'");
  sql.exec("INSERT INTO item_favorites(account_id,item_id,created_at) VALUES ('user','visible',1)");
  const creator = { id: 'owner', username: 'real', displayName: '真实作者' };
  const withCreator = {
    ...env,
    AUTH: Object.assign(env.AUTH, {
      marketCreatorsForItems: async (ids: string[]) =>
        ids.includes('visible') ? [{ itemId: 'visible', creator, workCount: 1 }] : [],
    }),
  };
  const response = await handleDiscovery(request('discovery?mode=favorites'), withCreator);
  expect((await response?.json()) as object).toMatchObject({
    items: [{ id: 'visible', author: 'somebody-else', verifiedCreator: creator }],
  });
});

it('shows only visible works backed by the requested creator claim', async () => {
  const { sql, env, request } = setup();
  sql.exec(
    "INSERT INTO items(id,type,name,content,created_at,hidden,tags) VALUES ('other','waveform','其他作者','{}',3,0,'')",
  );
  const creator = { id: 'owner', username: 'author', displayName: '作者' };
  const response = await handleDiscovery(request('discovery?mode=creator&creatorId=owner'), {
    ...env,
    AUTH: {
      ...env.AUTH,
      marketCreatorItems: async () => [
        { itemId: 'visible', creator },
        { itemId: 'hidden', creator },
        { itemId: 'other', creator: { id: 'another', username: 'other', displayName: '别人' } },
      ],
    },
  });
  expect(response?.status).toBe(200);
  expect(
    ((await response?.json()) as { items: MarketItem[] }).items.map((item) => item.id),
  ).toEqual(['visible']);
  expect(
    (await handleDiscovery(request('discovery?mode=creator&creatorId=../owner'), env))?.status,
  ).toBe(400);
});
it('rejects unauthenticated and switched-account requests before database writes', async () => {
  const { sql, env, request } = setup();
  expect((await handleDiscovery(request('visible/favorite', 'PUT', 'other'), env))?.status).toBe(
    409,
  );
  env.AUTH = { marketAccountIdentity: async () => null };
  expect((await handleDiscovery(request('visible/favorite', 'PUT'), env))?.status).toBe(401);
  expect(sql.prepare('SELECT COUNT(*) AS n FROM item_favorites').get()?.n).toBe(0);
});
it('explains tag matches, excludes already saved cards, and keeps ties deterministic', () => {
  const item = (id: string, tags: string[], downloads = 0): MarketItem => ({
    id,
    tags,
    downloads,
    name: id,
    type: 'scenario',
    content: { prompt: '' },
    views: 0,
    createdAt: 1,
  });
  const result = recommendItems(
    [item('saved', ['自然']), item('matching', ['自然']), item('popular', [], 100)],
    [item('saved', ['自然'])],
  );
  expect(result.map((entry) => entry.id)).toEqual(['matching', 'popular']);
  expect(result[0]?.recommendationReason).toContain('自然');
});

it('keeps each account list private and bounds visible favorites without duplicate rewards', async () => {
  const { sql, env, request } = setup();
  sql.exec(
    "INSERT INTO item_favorites(account_id,item_id,created_at) VALUES ('other','visible',1)",
  );
  const own = await handleDiscovery(request('discovery?mode=favorites'), env);
  expect(((await own?.json()) as { items: unknown[] }).items).toEqual([]);
  for (let n = 0; n < 200; n++) {
    sql
      .prepare(
        "INSERT INTO items(id,type,name,content,created_at) VALUES (?,'scenario','卡','{}',1)",
      )
      .run(`card-${n}`);
    sql
      .prepare("INSERT INTO item_favorites(account_id,item_id,created_at) VALUES ('user',?,1)")
      .run(`card-${n}`);
  }
  const batchSizes: number[] = [];
  Object.assign(env.AUTH, {
    marketCreatorsForItems: async (ids: string[]) => {
      batchSizes.push(ids.length);
      return [];
    },
  });
  const page = await handleDiscovery(request('discovery?mode=favorites'), env);
  expect(((await page?.json()) as { items: unknown[] }).items).toHaveLength(200);
  expect(batchSizes).toEqual([100, 100]);
  expect((await handleDiscovery(request('visible/favorite', 'PUT'), env))?.status).toBe(409);
  expect((await handleDiscovery(request('card-0/favorite', 'PUT'), env))?.status).toBe(200);
  await handleDiscovery(request('card-0/favorite', 'DELETE'), env);
  expect((await handleDiscovery(request('visible/favorite', 'PUT'), env))?.status).toBe(200);
});

it('follows a verified account rather than editable author and filters the following feed', async () => {
  const { sql, env, request } = setup();
  const creator = { id: 'creator', username: 'real', displayName: '真实账户' };
  const withCreator = {
    ...env,
    AUTH: Object.assign(env.AUTH, {
      marketItemCreator: async () => creator,
      marketCreatorItems: async () => [
        { itemId: 'visible', creator },
        { itemId: 'hidden', creator },
      ],
    }),
  };
  sql.exec("UPDATE items SET author='someone-else' WHERE id='visible'");
  const saved = await handleDiscovery(
    request('visible/creator-follow?creatorId=creator', 'PUT'),
    withCreator,
  );
  expect(saved?.status).toBe(200);
  expect(sql.prepare('SELECT creator_id FROM creator_follows').get()?.creator_id).toBe('creator');
  expect(
    (
      await handleDiscovery(
        request('visible/creator-follow?creatorId=impersonator', 'PUT'),
        withCreator,
      )
    )?.status,
  ).toBe(409);
  const feed = await handleDiscovery(request('discovery?mode=following'), withCreator);
  const data = (await feed?.json()) as { items: MarketItem[] };
  expect(data.items.map((item) => item.id)).toEqual(['visible']);
  expect(data.items[0]?.verifiedCreator?.username).toBe('real');
  expect(
    (
      await handleDiscovery(
        request('visible/creator-follow?creatorId=creator', 'PUT', 'wrong'),
        withCreator,
      )
    )?.status,
  ).toBe(409);
  expect(
    (await handleDiscovery(request('creator-follows/creator', 'DELETE'), withCreator))?.status,
  ).toBe(200);
  expect(sql.prepare('SELECT COUNT(*) AS n FROM creator_follows').get()?.n).toBe(0);
});
it('does not follow legacy cards without verified attribution or unavailable identity services', async () => {
  const { sql, env, request } = setup();
  expect(
    (await handleDiscovery(request('visible/creator-follow?creatorId=creator', 'PUT'), env))
      ?.status,
  ).toBe(503);
  const noCreator = {
    ...env,
    AUTH: Object.assign(env.AUTH, { marketItemCreator: async () => null }),
  };
  const result = await handleDiscovery(
    request('visible/creator-follow?creatorId=creator', 'PUT'),
    noCreator,
  );
  expect(await result?.json()).toMatchObject({ creator: null, followed: false });
  expect(sql.prepare('SELECT COUNT(*) AS n FROM creator_follows').get()?.n).toBe(0);
});
it('keeps unavailable followed accounts removable without trusting their card labels', async () => {
  const { sql, env, request } = setup();
  sql.exec(
    "INSERT INTO creator_follows(account_id,creator_id,created_at) VALUES ('user','missing',1),('other','private',2)",
  );
  const result = await handleDiscovery(request('creator-follows'), env);
  expect(await result?.json()).toEqual({
    creators: [{ id: 'missing', profile: null }],
    accountId: 'user',
  });
  await handleDiscovery(request('creator-follows/missing', 'DELETE'), env);
  expect(
    sql.prepare("SELECT COUNT(*) AS n FROM creator_follows WHERE account_id='user'").get()?.n,
  ).toBe(0);
});

it('bounds private feedback, verifies creator identity, and lets only its owner undo it', async () => {
  const { sql, env, request } = setup();
  sql
    .prepare("UPDATE items SET content=? WHERE id='visible'")
    .run(JSON.stringify({ prompt: '人设', characterCard: { schemaVersion: 1 } }));
  const creator = { id: 'creator', username: 'real', displayName: '真实账户' };
  const withCreator = {
    ...env,
    AUTH: { ...env.AUTH, marketItemCreator: async () => creator },
  };
  const put = (body: unknown, account = 'user') =>
    handleDiscoveryFeedback(
      new Request('https://market.test/api/items/visible/discovery-feedback', {
        method: 'PUT',
        headers: { 'X-Account-Id': account },
        body: JSON.stringify(body),
      }),
      withCreator,
    );
  expect((await put({ reason: 'hide_creator', creatorId: 'fake' }))?.status).toBe(409);
  expect((await put({ reason: 'hide_creator', creatorId: 'creator' }))?.status).toBe(200);
  expect((await put({ reason: 'hide_creator', creatorId: 'creator' }))?.status).toBe(200);
  expect(sql.prepare('SELECT COUNT(*) AS n FROM character_discovery_feedback').get()?.n).toBe(1);
  expect((await put({ reason: 'too_similar' }, 'other'))?.status).toBe(409);
  expect((await put({ reason: 'too_similar' }))?.status).toBe(200);
  const own = await handleDiscoveryFeedback(request('discovery-feedback'), withCreator);
  expect((await own?.json()) as { items: unknown[] }).toMatchObject({
    accountId: 'user',
    items: expect.arrayContaining([
      expect.objectContaining({ kind: 'item', reason: 'too_similar', sourceItemName: '公开' }),
    ]),
  });
  expect(
    (
      await handleDiscoveryFeedback(
        request('discovery-feedback/creator/creator', 'DELETE'),
        withCreator,
      )
    )?.status,
  ).toBe(200);
  expect(
    sql
      .prepare("SELECT COUNT(*) AS n FROM character_discovery_feedback WHERE target_kind='creator'")
      .get()?.n,
  ).toBe(0);
  sql.exec("UPDATE items SET hidden=1 WHERE id='visible'");
  expect((await put({ reason: 'not_interested' }))?.status).toBe(404);
});

it('limits each verified author, reserves new-author positions, and applies negative tag preferences', () => {
  const now = Date.now();
  const item = (id: string, tags: string[], downloads = 0): MarketItem => ({
    id,
    tags,
    downloads,
    name: id,
    type: 'scenario',
    content: { prompt: '人设' },
    views: 0,
    createdAt: now,
  });
  const candidates = [
    item('popular-1', ['自然'], 1000),
    item('popular-2', ['自然'], 900),
    item('popular-3', ['自然'], 800),
    item('popular-4', ['自然'], 700),
    item('new', ['书屋']),
    item('reduced', ['重复'], 50),
  ];
  const attribution = candidates.map((entry) => ({
    itemId: entry.id,
    creator: {
      id: entry.id === 'new' ? 'new-creator' : entry.id === 'reduced' ? 'other' : 'popular',
      username: 'public',
      displayName: '作者',
    },
    workCount: entry.id === 'new' ? 1 : 10,
  }));
  const result = recommendItems(
    candidates,
    [item('favorite', ['自然'])],
    attribution,
    [
      { target_kind: 'item', target_id: 'popular-4', reason: 'not_interested' },
      { target_kind: 'item', target_id: 'old', reason: 'too_similar', tags: '重复' },
    ],
    now,
  );
  expect(result.filter((entry) => entry.verifiedCreator?.id === 'popular')).toHaveLength(2);
  expect(result.map((entry) => entry.id)).not.toContain('popular-4');
  expect(result.find((entry) => entry.id === 'new')?.recommendationReason).toContain('新作者');
  expect(result.at(-1)?.id).toBe('reduced');
  const withoutOther = recommendItems(
    candidates,
    [],
    attribution,
    [{ target_kind: 'creator', target_id: 'other', reason: 'hide_creator' }],
    now,
  );
  expect(withoutOther.map((entry) => entry.id)).not.toContain('reduced');
});

it('caps stored feedback and bounded request bodies without blocking updates to an existing choice', async () => {
  const { sql, env } = setup();
  sql
    .prepare("UPDATE items SET content=? WHERE id='visible'")
    .run(JSON.stringify({ prompt: '人设', characterCard: { schemaVersion: 1 } }));
  for (let index = 0; index < 200; index++)
    sql
      .prepare(
        "INSERT INTO character_discovery_feedback(account_id,target_kind,target_id,reason,source_item_id,created_at) VALUES ('user','item',?,'not_interested','visible',1)",
      )
      .run(`old-${index}`);
  const put = (body: string) =>
    handleDiscoveryFeedback(
      new Request('https://market.test/api/items/visible/discovery-feedback', {
        method: 'PUT',
        headers: { 'X-Account-Id': 'user' },
        body,
      }),
      { ...env, AUTH: { ...env.AUTH, marketItemCreator: async () => null } },
    );
  expect((await put(JSON.stringify({ reason: 'not_interested' })))?.status).toBe(409);
  expect((await put('x'.repeat(501)))?.status).toBe(413);
  sql
    .prepare("UPDATE character_discovery_feedback SET target_id='visible' WHERE target_id='old-0'")
    .run();
  expect((await put(JSON.stringify({ reason: 'too_similar' })))?.status).toBe(200);
});
