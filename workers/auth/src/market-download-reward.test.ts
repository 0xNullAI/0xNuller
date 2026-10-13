import { afterEach, beforeEach, expect, it } from 'vitest';
import { AuthOwnershipService, type Env } from './index';
import { sha256Hex } from './session-domain';
import { createTestDb } from './test-helpers';

let db: ReturnType<typeof createTestDb>;
let env: Env;
let service: AuthOwnershipService;
beforeEach(async () => {
  db = createTestDb();
  env = { DB: db.DB } as Env;
  service = Object.create(AuthOwnershipService.prototype) as AuthOwnershipService;
  Object.assign(service, { env });
  await user('author');
  await env.DB.prepare(
    "INSERT INTO market_claims(item_id,user_id,claimed_at,verified_at) VALUES('item','author',1,1)",
  ).run();
});
afterEach(() => db.close());

async function user(id: string, verified = true) {
  await env.DB.prepare(
    'INSERT INTO users(id,username,display_name,password_hash,email_verified_at,created_at) VALUES(?,?,?,?,?,1)',
  )
    .bind(id, id, id, 'unused', verified ? 1 : null)
    .run();
  await env.DB.prepare(
    'INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,1,?)',
  )
    .bind(await sha256Hex(`token-${id}`), id, Date.now() + 60_000)
    .run();
  return { authorization: `Bearer token-${id}`, cookie: null };
}

const earned = async () =>
  (
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM credit_ledger WHERE user_id='author' AND kind='market_download_reward'",
    ).first<{ n: number }>()
  )?.n;

it('pays once per verified downloader and never for unverified, banned or repeated downloads', async () => {
  const fan = await user('fan');
  expect(await service.rewardMarketDownload(fan, 'item')).toBe('ok');
  expect(await service.rewardMarketDownload(fan, 'item')).toBe('duplicate');
  expect(await service.rewardMarketDownload(await user('fresh', false), 'item')).toBe('ineligible');
  const banned = await user('banned');
  await env.DB.prepare("UPDATE users SET banned_at=1 WHERE id='banned'").run();
  expect(await service.rewardMarketDownload(banned, 'item')).toBe('unauthorized');
  expect(await earned()).toBe(1);
});

it('stops paying an author past the daily cap but still records the new downloader', async () => {
  const now = Date.now();
  for (let n = 0; n < 100; n++) {
    await env.DB.prepare(
      "INSERT INTO credit_ledger(user_id,amount_credits,kind,reference_id,price_version,created_at) VALUES('author',1,'market_download_reward',?,'test',?)",
    )
      .bind(`seed:${n}`, now - 1000)
      .run();
  }
  expect(await service.rewardMarketDownload(await user('late'), 'item')).toBe('capped');
  expect(await earned()).toBe(100);
});

it('pays nothing for a banned author', async () => {
  await env.DB.prepare("UPDATE users SET banned_at=1 WHERE id='author'").run();
  expect(await service.rewardMarketDownload(await user('fan'), 'item')).toBe('not_found');
});
