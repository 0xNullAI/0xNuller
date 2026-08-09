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
    'market_claims',
    'user_profiles',
    'user_photos',
    'user_follows',
    'user_blocks',
    'dm_threads',
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
  ],
  'auth indexes',
);
assert(
  plan(
    auth.db,
    `SELECT id FROM user_content
      WHERE user_id = ? AND kind = ?
        AND (updated_at > ? OR (updated_at = ? AND id > ?))
      ORDER BY updated_at, id LIMIT ?`,
    'u',
    'waveform',
    0,
    0,
    '',
    500,
  ).includes('idx_content_sync_kind'),
  'auth: kind content sync does not use idx_content_sync_kind',
);
assert(
  plan(
    auth.db,
    `SELECT id FROM user_content
      WHERE user_id = ? AND (updated_at > ? OR (updated_at = ? AND id > ?))
      ORDER BY updated_at, id LIMIT ?`,
    'u',
    0,
    0,
    '',
    500,
  ).includes('idx_content_sync_all'),
  'auth: all-content sync does not use idx_content_sync_all',
);
assert(
  plan(auth.db, 'DELETE FROM login_attempts WHERE created_at < ?', 0).includes(
    'idx_attempts_created_at',
  ),
  'auth: login cleanup does not use idx_attempts_created_at',
);

// Existing production path: the live database already has 0001-0005. Applying only
// the additive 0006 must produce the same schema as a fresh sequential install.
const authUpgrade = new DatabaseSync(':memory:');
authUpgrade.exec('PRAGMA foreign_keys = ON');
for (const file of auth.files.slice(0, 5)) {
  authUpgrade.exec(readFileSync(join(root, 'workers/auth/migrations', file), 'utf8'));
}
authUpgrade.exec(readFileSync(join(root, 'workers/auth/migrations', auth.files[5]), 'utf8'));
assert(
  JSON.stringify(names(authUpgrade, 'index')) === JSON.stringify(names(auth.db, 'index')),
  'auth: 0001-0005 -> 0006 schema differs from fresh migration path',
);

const market = applyMigrations('apps/market/migrations');
expectNames(names(market.db, 'table'), ['items'], 'market tables');
expectNames(
  names(market.db, 'index'),
  ['idx_items_browse', 'idx_items_ip', 'idx_items_visible_new', 'idx_items_visible_popular'],
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

// Existing Market path: production already has the old schema and has recorded 0001.
// Wrangler will still see the newly introduced idempotent 0000 plus 0002 as pending.
// Recreate that shape and prove those two migrations converge with a fresh database.
const marketUpgrade = new DatabaseSync(':memory:');
marketUpgrade.exec(marketSnapshotSql.split('CREATE INDEX IF NOT EXISTS idx_items_visible_new')[0]);
marketUpgrade.exec(readFileSync(join(root, 'apps/market/migrations/0000_init.sql'), 'utf8'));
marketUpgrade.exec(
  readFileSync(join(root, 'apps/market/migrations/0002_browse_indexes.sql'), 'utf8'),
);
assert(
  JSON.stringify(names(marketUpgrade, 'index')) === JSON.stringify(names(market.db, 'index')),
  'market: recorded 0001 plus pending 0000/0002 differs from fresh migration path',
);

console.log(
  JSON.stringify({
    ok: true,
    authMigrations: auth.files,
    marketMigrations: market.files,
    marketGate: 'inspect d1_migrations before remote apply',
  }),
);

snapshot.close();
marketUpgrade.close();
authUpgrade.close();
market.db.close();
auth.db.close();
