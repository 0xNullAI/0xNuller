import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDb } from './test-helpers';
import {
  publicMarketCreator,
  publicMarketCreatorItems,
  publicMarketCreatorsForItems,
} from './public-market-creator';
let db: ReturnType<typeof createTestDb>;
let sql: D1Database;
beforeEach(async () => {
  db = createTestDb();
  sql = db.DB as D1Database;
  await sql
    .prepare(
      "INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES ('creator','realuser','真实作者','x',1)",
    )
    .run();
  await sql
    .prepare(
      "INSERT INTO market_claims(item_id,user_id,claimed_at,verified_at,proof_method) VALUES ('verified','creator',1,1,'market-upload'),('unverified','creator',2,NULL,NULL)",
    )
    .run();
});
afterEach(() => db.close());
it('attributes only verified claims to public account fields and follows stable IDs through renames', async () => {
  expect(await publicMarketCreator(sql, 'unverified')).toBeNull();
  expect(await publicMarketCreator(sql, 'verified')).toEqual({
    id: 'creator',
    username: 'realuser',
    displayName: '真实作者',
  });
  await sql.prepare("UPDATE users SET display_name='新名字' WHERE id='creator'").run();
  expect(await publicMarketCreatorItems(sql, ['creator'])).toEqual([
    { itemId: 'verified', creator: { id: 'creator', username: 'realuser', displayName: '新名字' } },
  ]);
  expect(await publicMarketCreatorItems(sql, Array(201).fill('creator'))).toEqual([]);
  expect(await publicMarketCreatorsForItems(sql, ['verified', 'unverified'])).toEqual([
    {
      itemId: 'verified',
      creator: { id: 'creator', username: 'realuser', displayName: '新名字' },
      workCount: 1,
    },
  ]);
  expect(await publicMarketCreatorsForItems(sql, Array(101).fill('verified'))).toEqual([]);
});
it('never publishes attribution for banned or deletion-pending accounts', async () => {
  await sql.prepare("UPDATE users SET banned_at=1 WHERE id='creator'").run();
  expect(await publicMarketCreator(sql, 'verified')).toBeNull();
  expect(await publicMarketCreatorItems(sql, ['creator'])).toEqual([]);
  expect(await publicMarketCreatorsForItems(sql, ['verified'])).toEqual([]);
  await sql.prepare("UPDATE users SET banned_at=NULL WHERE id='creator'").run();
  await sql
    .prepare("INSERT INTO account_deletions(user_id,requested_at) VALUES ('creator',1)")
    .run();
  expect(await publicMarketCreator(sql, 'verified')).toBeNull();
  expect(await publicMarketCreatorItems(sql, ['creator'])).toEqual([]);
  expect(await publicMarketCreatorsForItems(sql, ['verified'])).toEqual([]);
});

it('hides a creator’s claimed works from a viewer blocked in either direction', async () => {
  await sql
    .prepare(
      "INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES ('viewer','viewer','访客','x',1)",
    )
    .run();
  expect(await publicMarketCreatorItems(sql, ['creator'], 'viewer')).toHaveLength(1);
  await sql
    .prepare(
      "INSERT INTO user_blocks(blocker_id,blocked_id,created_at) VALUES ('viewer','creator',1)",
    )
    .run();
  expect(await publicMarketCreatorItems(sql, ['creator'], 'viewer')).toEqual([]);
  await sql
    .prepare("DELETE FROM user_blocks WHERE blocker_id='viewer' AND blocked_id='creator'")
    .run();
  await sql
    .prepare(
      "INSERT INTO user_blocks(blocker_id,blocked_id,created_at) VALUES ('creator','viewer',1)",
    )
    .run();
  expect(await publicMarketCreatorItems(sql, ['creator'], 'viewer')).toEqual([]);
});

it('looks up a full follow list within the D1 bound-parameter limit, newest claim first', async () => {
  const creators = Array.from({ length: 150 }, (_, n) => `creator-${n}`);
  for (const [n, id] of creators.entries()) {
    await sql
      .prepare(
        "INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES (?,?,?,'x',1)",
      )
      .bind(id, id, id)
      .run();
    await sql
      .prepare(
        "INSERT INTO market_claims(item_id,user_id,claimed_at,verified_at,proof_method) VALUES (?,?,?,1,'market-upload')",
      )
      .bind(`work-${n}`, id, 10 + n)
      .run();
  }
  const limited = {
    prepare: (query: string) => {
      const statement = sql.prepare(query);
      return {
        bind: (...values: unknown[]) => {
          if (values.length > 100) throw new Error('too many SQL variables');
          return statement.bind(...values);
        },
      };
    },
  } as unknown as D1Database;
  const items = await publicMarketCreatorItems(limited, creators, 'viewer');
  expect(items).toHaveLength(150);
  expect(items[0]).toMatchObject({ itemId: 'work-149', creator: { id: 'creator-149' } });
});
