/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  handleCharacterConversion,
  purgeExpiredCharacterConversions,
  purgeInactiveDiscoveryOwners,
} from './character-conversion';

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function setup() {
  const sql = new DatabaseSync(':memory:');
  databases.push(sql);
  for (const name of ['0000_init.sql', '0011_character_discovery_feedback.sql'])
    sql.exec(readFileSync(join(import.meta.dirname, '../../migrations', name), 'utf8'));
  sql
    .prepare(
      "INSERT INTO items(id,type,name,content,created_at) VALUES ('card','scenario','角色',?,1)",
    )
    .run(JSON.stringify({ prompt: '人设', characterCard: { schemaVersion: 1 } }));
  sql.exec(
    "INSERT INTO items(id,type,name,content,created_at) VALUES ('old','scenario','旧场景','{\"prompt\":\"旧版\"}',1)",
  );
  function prepare(query: string, args: unknown[] = []) {
    return {
      bind: (...values: unknown[]) => prepare(query, values),
      first: async () => sql.prepare(query).get(...(args as never[])) ?? null,
      all: async () => ({ results: sql.prepare(query).all(...(args as never[])) }),
      run: async () => ({
        meta: { changes: sql.prepare(query).run(...(args as never[])).changes },
      }),
    };
  }
  const env = {
    DB: { prepare } as unknown as D1Database,
    AUTH: {
      marketAccountIdentity: async ({ authorization }: { authorization: string | null }) =>
        authorization?.startsWith('Bearer ') ? { id: authorization.slice(7) } : null,
      marketAccountAccess: async ({ authorization }: { authorization: string | null }) =>
        authorization === 'Bearer admin' ? ('admin' as const) : ('user' as const),
      marketAccountActive: async (id: string) => id !== 'deleted',
    },
  };
  const call = (path: string, account = 'alice', method = 'POST', now = 86_400_000 * 100) =>
    handleCharacterConversion(
      new Request(`https://market.test/api/items/${path}`, {
        method,
        headers: { Authorization: `Bearer ${account}`, 'X-Account-Id': account },
      }),
      env,
      now,
    );
  return { sql, env, call };
}

it('dedupes character starts and excludes legacy prompt-only scenes', async () => {
  const { sql, env, call } = setup();
  expect((await call('old/character-start'))?.status).toBe(404);
  expect((await call('card/character-detail-open'))?.status).toBe(200);
  expect((await call('card/character-detail-open'))?.status).toBe(200);
  expect((await call('card/character-start'))?.status).toBe(200);
  expect((await call('card/character-start'))?.status).toBe(200);
  expect(
    sql
      .prepare(
        'SELECT item_id,event_type FROM character_conversion_events ORDER BY item_id,event_type',
      )
      .all(),
  ).toEqual([
    { item_id: 'card', event_type: 'detail_open' },
    { item_id: 'card', event_type: 'start' },
  ]);
  expect(
    (
      await handleCharacterConversion(
        new Request('https://market.test/api/items/card/character-start', {
          method: 'POST',
          headers: { Authorization: 'Bearer alice', 'X-Account-Id': 'bob' },
        }),
        env,
      )
    )?.status,
  ).toBe(409);
  expect(
    (
      await handleCharacterConversion(
        new Request('https://market.test/api/items/card/character-start', { method: 'POST' }),
        env,
      )
    )?.status,
  ).toBe(401);
  sql.exec("UPDATE items SET hidden=1 WHERE id='card'");
  expect((await call('card/character-start'))?.status).toBe(404);
});

it('purges deleted account preferences and events while keeping active owners', async () => {
  const { sql, env, call } = setup();
  await call('card/character-start', 'alice');
  await call('card/character-start', 'deleted');
  sql
    .prepare(
      "INSERT INTO character_discovery_feedback(account_id,target_kind,target_id,reason,source_item_id,created_at) VALUES ('deleted','item','card','not_interested','card',1)",
    )
    .run();
  await purgeInactiveDiscoveryOwners(env, 123);
  expect(sql.prepare('SELECT account_id FROM character_conversion_events').all()).toEqual([
    { account_id: 'alice' },
  ]);
  expect(sql.prepare('SELECT account_id FROM character_discovery_feedback').all()).toEqual([]);
  expect(
    sql.prepare('SELECT account_id,last_checked_at FROM character_discovery_owner_checks').all(),
  ).toEqual([{ account_id: 'alice', last_checked_at: 123 }]);
});

it('shows only admin aggregate counts after five accounts and expires raw events at 30 days', async () => {
  const { sql, env, call } = setup();
  for (const account of ['a', 'b', 'c', 'd', 'e']) {
    await call('card/character-detail-open', account);
    if (account !== 'e') await call('card/character-start', account);
  }
  expect((await call('admin/character-conversions', 'alice', 'GET'))?.status).toBe(403);
  const aggregate = await call('admin/character-conversions', 'admin', 'GET');
  expect(await aggregate?.json()).toEqual({
    windowDays: 30,
    items: [{ itemId: 'card', itemName: '角色', openedAccounts: 5, startedAccounts: 4 }],
  });
  expect(
    JSON.stringify(await (await call('admin/character-conversions', 'admin', 'GET'))?.json()),
  ).not.toContain('account_id');
  await purgeExpiredCharacterConversions(env.DB, 86_400_000 * 130);
  expect(sql.prepare('SELECT COUNT(*) AS n FROM character_conversion_events').get()).toEqual({
    n: 0,
  });
});
