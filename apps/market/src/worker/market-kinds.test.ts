/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { UploadSchema, promptKind } from '../shared/schema';
import { getItem, listItems } from './db';
import worker from './index';

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function setup() {
  const sql = new DatabaseSync(':memory:');
  databases.push(sql);
  sql.exec('PRAGMA foreign_keys = ON');
  for (const migration of [
    '0000_init.sql',
    '0005_item_favorites.sql',
    '0007_character_versions.sql',
    '0014_item_publish_order.sql',
  ]) {
    sql.exec(readFileSync(join(import.meta.dirname, '../../migrations', migration), 'utf8'));
  }
  const insert = sql.prepare(
    'INSERT INTO items(id,type,name,content,created_at) VALUES (?,?,?,?,1)',
  );
  insert.run('legacy-scene', 'scenario', '旧场景', JSON.stringify({ prompt: '森林' }));
  insert.run(
    'legacy-character',
    'scenario',
    '旧角色',
    JSON.stringify({ prompt: '朋友', characterCard: { schemaVersion: 1 } }),
  );
  insert.run('scene', 'scenario', '新场景', JSON.stringify({ kind: 'scene', prompt: '咖啡店' }));
  insert.run(
    'character',
    'scenario',
    '新角色',
    JSON.stringify({ kind: 'character', prompt: '伙伴', characterCard: { schemaVersion: 1 } }),
  );
  insert.run(
    'multi',
    'multi-scene',
    '旧多人场景',
    JSON.stringify({ setting: '旧世界', roles: [{ name: '旅人' }] }),
  );
  sql.exec("INSERT INTO item_favorites(account_id,item_id,created_at) VALUES ('user','multi',1)");
  function prepare(query: string, args: unknown[] = []) {
    return {
      bind: (...values: unknown[]) => prepare(query, values),
      first: async () => sql.prepare(query).get(...(args as never[])) ?? null,
      all: async () => ({ results: sql.prepare(query).all(...(args as never[])) }),
    };
  }
  return { sql, db: { prepare } as unknown as D1Database };
}

it('classifies old public cards and excludes retired multiplayer content from every public list', async () => {
  const { db } = setup();
  const list = (promptKind?: 'character' | 'scene') =>
    listItems(db, { promptKind, sort: 'new', limit: 50, offset: 0 });
  expect((await list()).map((item) => item.id)).toEqual([
    'scene',
    'legacy-scene',
    'legacy-character',
    'character',
  ]);
  expect((await list('scene')).map((item) => item.id)).toEqual(['scene', 'legacy-scene']);
  expect((await list('character')).map((item) => item.id)).toEqual([
    'legacy-character',
    'character',
  ]);
  expect(
    (await listItems(db, { character: true, sort: 'new', limit: 50, offset: 0 })).map(
      (item) => item.id,
    ),
  ).toEqual(['legacy-character', 'character']);
  expect(await getItem(db, 'multi')).toBeNull();
});

it('pages visible content with a stable tie-breaker and keeps retired multiplayer content out', async () => {
  const { db } = setup();
  const first = await listItems(db, { sort: 'new', limit: 2, offset: 0 });
  const second = await listItems(db, { sort: 'new', limit: 2, offset: 2 });
  expect([...first, ...second].map((item) => item.id)).toEqual([
    'scene',
    'legacy-scene',
    'legacy-character',
    'character',
  ]);
});

it('cursor browsing keeps the original publish boundary across concurrent inserts and equal timestamps', async () => {
  const { db, sql } = setup();
  const env = {
    DB: db,
    MARKET_IP_PEPPER: 'test-secret',
    AUTH: { marketCreatorsForItems: async () => [] },
  } as never;
  const page = async (cursor?: string) => {
    const url = new URL(
      'https://market.test/api/items?pagination=cursor&sort=new&limit=2&type=scenario',
    );
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await worker.fetch(new Request(url), env);
    expect(response.status).toBe(200);
    return response.json() as Promise<{
      items: Array<{ id: string }>;
      nextCursor: string | null;
      pagination: string;
    }>;
  };
  const first = await page();
  expect(first.items.map((item) => item.id)).toEqual(['scene', 'legacy-scene']);
  expect(first.pagination).toBe('stable');
  sql.prepare('DELETE FROM item_favorites WHERE item_id=?').run('multi');
  sql.prepare('DELETE FROM items WHERE id=?').run('multi');
  sql
    .prepare('INSERT INTO items(id,type,name,content,created_at) VALUES (?,?,?,?,?)')
    .run('fresh-newer', 'scenario', '新发布', '{}', 2);
  // An insert with the *same* timestamp and an ID below the frontier is also excluded.
  sql
    .prepare('INSERT INTO items(id,type,name,content,created_at) VALUES (?,?,?,?,?)')
    .run('legacy-insert', 'scenario', '同秒发布', '{}', 1);
  const second = await page(first.nextCursor!);
  expect(second.items.map((item) => item.id)).toEqual(['legacy-character', 'character']);
  expect(second.nextCursor).toBeNull();
  expect((await page()).items[0]?.id).toBe('fresh-newer');
});

it('cursor browsing rechecks hidden state and refuses mismatched filters or malformed positions', async () => {
  const { db, sql } = setup();
  const env = {
    DB: db,
    MARKET_IP_PEPPER: 'test-secret',
    AUTH: { marketCreatorsForItems: async () => [] },
  } as never;
  const firstResponse = await worker.fetch(
    new Request('https://market.test/api/items?pagination=cursor&sort=new&limit=2&type=scenario'),
    env,
  );
  const first = (await firstResponse.json()) as { nextCursor: string };
  sql.prepare('UPDATE items SET hidden=1 WHERE id=?').run('legacy-character');
  const next = new URL(
    'https://market.test/api/items?pagination=cursor&sort=new&limit=2&type=scenario',
  );
  next.searchParams.set('cursor', first.nextCursor);
  const secondResponse = await worker.fetch(new Request(next), env);
  const second = (await secondResponse.json()) as { items: Array<{ id: string }> };
  expect(second.items.map((item) => item.id)).toEqual(['character']);
  next.searchParams.set('kind', 'scene');
  expect((await worker.fetch(new Request(next), env)).status).toBe(400);
  next.searchParams.set('cursor', 'bad!');
  expect((await worker.fetch(new Request(next), env)).status).toBe(400);
  const tampered = `${first.nextCursor.startsWith('A') ? 'B' : 'A'}${first.nextCursor.slice(1)}`;
  next.searchParams.set('cursor', tampered);
  expect((await worker.fetch(new Request(next), env)).status).toBe(400);
});

it('live engagement cursors identify mutable ordering while legacy offset stays supported', async () => {
  const { db } = setup();
  const env = {
    DB: db,
    MARKET_IP_PEPPER: 'test-secret',
    AUTH: { marketCreatorsForItems: async () => [] },
  } as never;
  const live = await worker.fetch(
    new Request('https://market.test/api/items?pagination=cursor&sort=views&limit=2'),
    env,
  );
  expect(await live.json()).toMatchObject({ pagination: 'live', nextCursor: expect.any(String) });
  const legacy = await worker.fetch(
    new Request('https://market.test/api/items?sort=new&limit=2&offset=2'),
    env,
  );
  const body = (await legacy.json()) as { items: Array<{ id: string }>; nextCursor?: string };
  expect(body.items.map((item) => item.id)).toEqual(['legacy-character', 'character']);
  expect(body.nextCursor).toBeUndefined();
});

it('shows verified publishing accounts on public browse and detail without trusting editable author', async () => {
  const { db } = setup();
  const creator = { id: 'account-1', username: 'verified', displayName: '真实作者' };
  const env = {
    DB: db,
    AUTH: {
      marketCreatorsForItems: async (ids: string[]) => {
        expect(ids).toContain('character');
        return [{ itemId: 'character', creator, workCount: 1 }];
      },
      marketItemCreator: async (id: string) => (id === 'character' ? creator : null),
    },
  } as never;
  const list = await worker.fetch(new Request('https://market.test/api/items?kind=character'), env);
  expect(list.status).toBe(200);
  const listed = (await list.json()) as {
    items: Array<{ id: string; verifiedCreator?: typeof creator }>;
  };
  expect(listed.items.find((item) => item.id === 'character')?.verifiedCreator).toEqual(creator);
  expect(
    listed.items.find((item) => item.id === 'legacy-character')?.verifiedCreator,
  ).toBeUndefined();
  const detail = await worker.fetch(new Request('https://market.test/api/items/character'), env);
  expect((await detail.json()) as object).toMatchObject({ item: { verifiedCreator: creator } });
});

it('rejects retired multiplayer uploads and inconsistent character or scene contents', async () => {
  const legacyMulti = {
    type: 'multi-scene',
    name: '旧多人',
    content: { setting: '旧世界', roles: [{ name: '旅人' }] },
  };
  expect(UploadSchema.safeParse(legacyMulti).success).toBe(false);
  expect(
    UploadSchema.safeParse({
      type: 'scenario',
      name: '错误场景',
      content: { kind: 'scene', prompt: '雨天', characterCard: { schemaVersion: 1 } },
    }).success,
  ).toBe(false);
  expect(
    UploadSchema.safeParse({
      type: 'scenario',
      name: '错误角色',
      content: { kind: 'character', prompt: '友人' },
    }).success,
  ).toBe(false);
  expect(promptKind({ characterCard: { schemaVersion: 1 } })).toBe('character');
  expect(promptKind({})).toBe('scene');

  const env = { DB: {}, AUTH: {} } as never;
  expect(
    (
      await worker.fetch(
        new Request('https://market.test/api/items', {
          method: 'POST',
          body: JSON.stringify(legacyMulti),
        }),
        env,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await worker.fetch(
        new Request('https://market.test/api/items/batch', {
          method: 'POST',
          body: JSON.stringify([legacyMulti]),
        }),
        env,
      )
    ).status,
  ).toBe(400);
  for (const query of ['type=multi-scene', 'kind=multi']) {
    expect(
      (await worker.fetch(new Request(`https://market.test/api/items?${query}`), env)).status,
    ).toBe(400);
  }
  expect(
    (
      await worker.fetch(new Request('https://market.test/api/items/admin?type=multi-scene'), {
        DB: {},
        AUTH: { marketAccountAccess: async () => 'admin' },
      } as never)
    ).status,
  ).toBe(400);
});

it('retirement migration hides old multiplayer rows, keeps them recoverable and rejects their return', () => {
  const { sql } = setup();
  sql.exec(
    readFileSync(join(import.meta.dirname, '../../migrations/0013_retire_multi_scene.sql'), 'utf8'),
  );
  expect(sql.prepare("SELECT hidden FROM items WHERE id='multi'").get()?.hidden).toBe(1);
  expect(
    sql.prepare("SELECT COUNT(*) AS n FROM item_favorites WHERE item_id='multi'").get()?.n,
  ).toBe(1);
  expect(() => sql.exec("UPDATE items SET hidden=0 WHERE id='multi'")).toThrow(
    /multi-scene retired/,
  );
  sql.exec("UPDATE items SET name='archived' WHERE id='multi'");
  expect(() =>
    sql.exec(
      "INSERT INTO items(id,type,name,content,created_at) VALUES ('new-multi','multi-scene','n','{}',2)",
    ),
  ).toThrow(/multi-scene retired/);
  expect(() => sql.exec("UPDATE items SET type='multi-scene' WHERE id='scene'")).toThrow(
    /multi-scene retired/,
  );
  expect(sql.prepare("SELECT type FROM items WHERE id='scene'").get()?.type).toBe('scenario');
});
