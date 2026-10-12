/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { listItems } from './db';

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

function setup(rows: { id: string; ageHours: number; views: number; downloads: number }[]) {
  const sql = new DatabaseSync(':memory:');
  databases.push(sql);
  for (const migration of [
    '0000_init.sql',
    '0005_item_favorites.sql',
    '0007_character_versions.sql',
  ]) {
    sql.exec(readFileSync(join(import.meta.dirname, '../../migrations', migration), 'utf8'));
  }
  const insert = sql.prepare(
    'INSERT INTO items(id,type,name,content,views,downloads,created_at) VALUES (?,?,?,?,?,?,?)',
  );
  for (const row of rows)
    insert.run(
      row.id,
      'scenario',
      row.id,
      JSON.stringify({ kind: 'character', prompt: 'p', characterCard: { schemaVersion: 1 } }),
      row.views,
      row.downloads,
      NOW - row.ageHours * HOUR,
    );
  function prepare(query: string, args: unknown[] = []) {
    return {
      bind: (...values: unknown[]) => prepare(query, values),
      first: async () => sql.prepare(query).get(...(args as never[])) ?? null,
      all: async () => ({ results: sql.prepare(query).all(...(args as never[])) }),
    };
  }
  return { sql, db: { prepare } as unknown as D1Database };
}

it('综合排序 puts proven cards above brand-new empty ones, and lets age wear popularity down', async () => {
  const { db, sql } = setup([
    { id: 'fresh-empty', ageHours: 0, views: 0, downloads: 0 },
    { id: 'hot-yesterday', ageHours: 24, views: 300, downloads: 40 },
    { id: 'old-famous', ageHours: 24 * 60, views: 900, downloads: 100 },
    { id: 'old-dead', ageHours: 24 * 30, views: 1, downloads: 0 },
    { id: 'two-days-liked', ageHours: 48, views: 50, downloads: 0 },
  ]);
  sql.exec(
    "INSERT INTO item_favorites(account_id,item_id,created_at) VALUES ('u','fresh-empty',1)",
  );
  const ids = (await listItems(db, { sort: 'trending', limit: 10, offset: 0, now: NOW })).map(
    (item) => item.id,
  );
  expect(ids).toEqual(['hot-yesterday', 'two-days-liked', 'fresh-empty', 'old-famous', 'old-dead']);
  // 最新发布 is still plain recency.
  expect((await listItems(db, { sort: 'new', limit: 10, offset: 0 }))[0]!.id).toBe('fresh-empty');
});
