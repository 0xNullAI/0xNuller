import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function applyMigrations(relativeDirectory) {
  const directory = join(root, relativeDirectory);
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const files = readdirSync(directory)
    .filter((file) => file.endsWith('.sql'))
    .sort();
  assert(files.length > 0, `${relativeDirectory}: no migrations`);
  for (const file of files) db.exec(readFileSync(join(directory, file), 'utf8'));
  assert(
    db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok',
    `${relativeDirectory}: integrity_check failed`,
  );
  assert(
    db.prepare('PRAGMA foreign_key_check').all().length === 0,
    `${relativeDirectory}: foreign_key_check failed`,
  );
  return { db, files };
}

function names(db, type) {
  return db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all(type)
    .map((row) => row.name);
}

function expectNames(actual, expected, label) {
  for (const name of expected) assert(actual.includes(name), `${label}: missing ${name}`);
}

function plan(db, sql, ...binds) {
  return db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...binds)
    .map((row) => String(row.detail))
    .join('\n');
}

const auth = applyMigrations('workers/auth/migrations');
expectNames(
  names(auth.db, 'table'),
  [
    'users',
    'sessions',
    'login_attempts',
    'user_settings',
    'user_content',
    'content_entities',
    'user_content_refs',
    'user_content_preferences',
    'market_claims',
    'user_profiles',
    'user_photos',
    'user_follows',
    'user_blocks',
    'dm_threads',
    'account_deletions',
    'ai_usage_daily',
  ],
  'auth tables',
);
expectNames(
  names(auth.db, 'index'),
  [
    'idx_photos_object_key',
    'idx_content_sync_all',
    'idx_content_sync_kind',
    'idx_attempts_created_at',
    'idx_claims_verified_user',
    'idx_photos_user_slot',
    'idx_photos_pending_cleanup',
    'idx_account_deletions_requested',
    'idx_content_refs_sync',
    'idx_content_entities_owner_kind',
    'idx_ai_usage_day',
  ],
  'auth indexes',
);
assert(
  plan(
    auth.db,
    `SELECT client_id FROM user_content_refs
      WHERE user_id = ? AND (updated_at > ? OR (updated_at = ? AND client_id > ?))
      ORDER BY updated_at, client_id LIMIT ?`,
    'u',
    0,
    0,
    '',
    500,
  ).includes('idx_content_refs_sync'),
  'auth: entity-reference content sync does not use idx_content_refs_sync',
);
assert(
  plan(auth.db, 'DELETE FROM login_attempts WHERE created_at < ?', 0).includes(
    'idx_attempts_created_at',
  ),
  'auth: login cleanup does not use idx_attempts_created_at',
);

// Actual production path (2026-08-09 inventory): the live Auth database has only
// 0001-0003 recorded. Applying all later migrations must converge with a fresh install.
const authUpgrade = new DatabaseSync(':memory:');
authUpgrade.exec('PRAGMA foreign_keys = ON');
for (const file of auth.files.slice(0, 3)) {
  authUpgrade.exec(readFileSync(join(root, 'workers/auth/migrations', file), 'utf8'));
}
for (const file of auth.files.slice(3)) {
  authUpgrade.exec(readFileSync(join(root, 'workers/auth/migrations', file), 'utf8'));
}
assert(
  JSON.stringify(names(authUpgrade, 'index')) === JSON.stringify(names(auth.db, 'index')),
  'auth: existing 0001-0003 upgrade schema differs from fresh migration path',
);
assert(
  JSON.stringify(names(authUpgrade, 'table')) === JSON.stringify(names(auth.db, 'table')),
  'auth: existing 0001-0003 upgrade tables differ from fresh migration path',
);

// The deployed 0001-0012 shape contains payload-per-user rows. 0013 must preserve
// them while moving the body into an owned entity and leaving only a reference.
const auth0012Upgrade = new DatabaseSync(':memory:');
auth0012Upgrade.exec('PRAGMA foreign_keys = ON');
for (const file of auth.files.slice(0, 12))
  auth0012Upgrade.exec(readFileSync(join(root, 'workers/auth/migrations', file), 'utf8'));
auth0012Upgrade
  .prepare(
    `INSERT INTO users (id, username, display_name, password_hash, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
  .run('owner', 'owner', 'Owner', 'hash', 1);
auth0012Upgrade
  .prepare(
    `INSERT INTO user_content (id, user_id, kind, name, payload, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  .run('wave-1', 'owner', 'waveform', 'Mine', '{"frames":[[10,20]]}', 2, 3);
auth0012Upgrade.exec(
  readFileSync(join(root, 'workers/auth/migrations/0013_content_entities.sql'), 'utf8'),
);
assert(
  auth0012Upgrade.prepare('SELECT COUNT(*) AS n FROM content_entities').get().n === 1,
  'auth 0013: legacy content entity was not backfilled',
);
assert(
  auth0012Upgrade.prepare('SELECT COUNT(*) AS n FROM user_content_refs').get().n === 1,
  'auth 0013: legacy user reference was not backfilled',
);
assert(
  auth0012Upgrade
    .prepare(
      `SELECT e.payload FROM user_content_refs r JOIN content_entities e ON e.id = r.content_id
   WHERE r.user_id = ? AND r.client_id = ?`,
    )
    .get('owner', 'wave-1')?.payload === '{"frames":[[10,20]]}',
  'auth 0013: legacy payload changed during backfill',
);

const market = applyMigrations('apps/market/migrations');
expectNames(names(market.db, 'table'), ['items'], 'market tables');
expectNames(
  names(market.db, 'index'),
  [
    'idx_items_browse',
    'idx_items_ip',
    'idx_items_visible_new',
    'idx_items_visible_popular',
    'idx_items_edit_key_scheme',
  ],
  'market indexes',
);
assert(
  plan(
    market.db,
    'SELECT * FROM items WHERE hidden = 0 ORDER BY created_at DESC LIMIT ? OFFSET ?',
    30,
    0,
  ).includes('idx_items_visible_new'),
  'market: newest browse does not use idx_items_visible_new',
);
assert(
  plan(
    market.db,
    'SELECT * FROM items WHERE hidden = 0 ORDER BY downloads DESC, created_at DESC LIMIT ? OFFSET ?',
    30,
    0,
  ).includes('idx_items_visible_popular'),
  'market: popular browse does not use idx_items_visible_popular',
);
const seededScenario = market.db
  .prepare('SELECT type, hidden, content FROM items WHERE id = ?')
  .get('mistbound-menagerie-guide');
assert(
  seededScenario?.type === 'scenario' && seededScenario.hidden === 0,
  'market: fresh migrations did not create the public v6.1 scenario',
);
const seededContent = JSON.parse(seededScenario.content);
assert(
  typeof seededContent.prompt === 'string' &&
    seededContent.prompt.trim().length > 0 &&
    seededContent.prompt.length <= 12_000,
  'market: seeded scenario prompt is invalid',
);

const snapshot = new DatabaseSync(':memory:');
const marketSnapshotSql = readFileSync(join(root, 'apps/market/schema.sql'), 'utf8');
snapshot.exec(marketSnapshotSql);
assert(
  JSON.stringify(snapshot.prepare('PRAGMA table_info(items)').all()) ===
    JSON.stringify(market.db.prepare('PRAGMA table_info(items)').all()),
  'market: schema.sql snapshot drifted from migrations',
);

const publishedMarket0001 = readFileSync(
  join(root, 'apps/market/migrations/0001_add_edit_key.sql'),
  'utf8',
);
assert(
  publishedMarket0001.includes('ALTER TABLE items ADD COLUMN edit_key_hash TEXT'),
  'market: published 0001 was rewritten instead of preserved',
);

// Actual production path (2026-08-09 inventory): raw schema, 44 rows, edit_key_hash
// already present, and no d1_migrations table. Recreate it; bootstrap only the ledger;
// then apply 0002-0004 and prove rows plus schema are preserved.
const marketUpgrade = new DatabaseSync(':memory:');
marketUpgrade.exec(readFileSync(join(root, 'apps/market/migrations/0000_init.sql'), 'utf8'));
marketUpgrade.exec(
  readFileSync(join(root, 'apps/market/migrations/0001_add_edit_key.sql'), 'utf8'),
);
const rawInsert = marketUpgrade.prepare(
  `INSERT INTO items
    (id, type, name, content, downloads, views, reports, hidden, ip_hash, created_at, edit_key_hash)
   VALUES (?, 'waveform', ?, '{"frames":[[10,0]]}', 0, 0, 0, 0, ?, ?, ?)`,
);
for (let i = 0; i < 44; i++) {
  rawInsert.run(`raw-${i}`, `raw ${i}`, `ip-${i}`, i, i % 2 ? `legacy-${i}` : null);
}
marketUpgrade.exec(
  readFileSync(join(root, 'scripts/bootstrap-market-migration-ledger.sql'), 'utf8'),
);
marketUpgrade.exec(
  readFileSync(join(root, 'apps/market/migrations/0002_browse_indexes.sql'), 'utf8'),
);
marketUpgrade.exec(
  readFileSync(join(root, 'apps/market/migrations/0003_separate_security_domains.sql'), 'utf8'),
);
const marketSeedMigration = readFileSync(
  join(root, 'apps/market/migrations/0004_seed_mistbound_scenario.sql'),
  'utf8',
);
marketUpgrade.exec(marketSeedMigration);
marketUpgrade.exec(marketSeedMigration);
assert(
  JSON.stringify(names(marketUpgrade, 'index')) === JSON.stringify(names(market.db, 'index')),
  'market: raw-ledger bootstrap plus 0002-0004 differs from fresh migration path',
);
assert(
  marketUpgrade.prepare("SELECT COUNT(*) AS n FROM items WHERE id LIKE 'raw-%'").get().n === 44,
  'market: raw-ledger bootstrap changed the 44 existing item rows',
);
assert(
  marketUpgrade
    .prepare('SELECT COUNT(*) AS n FROM items WHERE id = ? AND type = ? AND hidden = 0')
    .get('mistbound-menagerie-guide', 'scenario').n === 1,
  'market: v6.1 scenario seed was not idempotent on an existing database',
);
assert(
  marketUpgrade
    .prepare(
      'SELECT COUNT(*) AS n FROM items WHERE edit_key_hash IS NOT NULL AND edit_key_scheme = 1',
    )
    .get().n === 22,
  'market: legacy edit hashes were not preserved as scheme 1',
);
assert(
  JSON.stringify(
    marketUpgrade
      .prepare('SELECT name FROM d1_migrations ORDER BY id')
      .all()
      .map((r) => r.name),
  ) === JSON.stringify(['0000_init.sql', '0001_add_edit_key.sql']),
  'market: bootstrap ledger did not record exactly 0000/0001',
);

console.log(
  JSON.stringify({
    ok: true,
    authMigrations: auth.files,
    marketMigrations: market.files,
    authUpgrade: '0001-0003 -> current',
    marketUpgrade: 'raw 44 rows + ledger bootstrap -> 0002-0004 (0004 rerun idempotently)',
  }),
);

snapshot.close();
marketUpgrade.close();
authUpgrade.close();
market.db.close();
auth.db.close();
