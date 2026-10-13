/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import worker from './index';

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function setup(reward: string) {
  const sql = new DatabaseSync(':memory:');
  databases.push(sql);
  for (const migration of ['0000_init.sql', '0014_item_publish_order.sql']) {
    sql.exec(readFileSync(join(import.meta.dirname, '../../migrations', migration), 'utf8'));
  }
  const insert = sql.prepare(
    'INSERT INTO items(id,type,name,content,hidden,created_at) VALUES (?,?,?,?,?,1)',
  );
  insert.run('shown', 'scenario', '公开', '{}', 0);
  insert.run('hidden', 'scenario', '隐藏', '{}', 1);
  function prepare(query: string, args: unknown[] = []) {
    return {
      bind: (...values: unknown[]) => prepare(query, values),
      first: async () => sql.prepare(query).get(...(args as never[])) ?? null,
      run: async () => sql.prepare(query).run(...(args as never[])),
    };
  }
  const rewardMarketDownload = vi.fn(async () => reward);
  const env = {
    DB: { prepare } as unknown as D1Database,
    MARKET_IP_PEPPER: 'test-secret',
    AUTH: { rewardMarketDownload },
  } as never;
  const download = (id: string) =>
    worker.fetch(
      new Request(`https://market.test/api/items/${id}/download`, { method: 'POST' }),
      env,
    );
  const downloads = (id: string) =>
    (sql.prepare('SELECT downloads FROM items WHERE id=?').get(id) as { downloads: number })
      .downloads;
  return { download, downloads, rewardMarketDownload };
}

it.each([
  ['ok', 1],
  ['capped', 1],
  ['duplicate', 0],
  ['unauthorized', 0],
  ['ineligible', 0],
  ['invalid', 0],
])('counts a download only for a first eligible download (%s)', async (reward, counted) => {
  const { download, downloads } = setup(reward);
  expect((await download('shown')).status).toBe(200);
  expect(downloads('shown')).toBe(counted);
});

it('neither rewards nor counts a hidden item', async () => {
  const { download, downloads, rewardMarketDownload } = setup('ok');
  expect((await download('hidden')).status).toBe(404);
  expect(rewardMarketDownload).not.toHaveBeenCalled();
  expect(downloads('hidden')).toBe(0);
});
