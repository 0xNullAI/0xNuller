import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const confirm = '--confirm=dg-market,0xnullai-auth';

if (!process.argv.includes('--remote-readonly') || !process.argv.includes(confirm)) {
  console.error(
    [
      'Refusing to contact production without both explicit read-only flags:',
      `  npm run release:data:preflight -- --remote-readonly ${confirm}`,
      'This command performs SELECT/PRAGMA only; it never creates, migrates or deploys.',
    ].join('\n'),
  );
  process.exit(2);
}

const wrangler = join(root, 'node_modules/.bin/wrangler');

function remoteQuery(database, config, sql) {
  const result = spawnSync(
    wrangler,
    ['d1', 'execute', database, '--remote', '--config', config, '--command', sql, '--json'],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (result.status !== 0) {
    throw new Error(`${database} read-only query failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

function rows(results, index) {
  return results[index]?.results ?? [];
}

function scalar(results, index, key) {
  return Number(rows(results, index)[0]?.[key] ?? 0);
}

const market = remoteQuery(
  'dg-market',
  'apps/market/wrangler.jsonc',
  [
    "SELECT name FROM pragma_table_info('items') ORDER BY cid",
    "SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name='items' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    "SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='table' AND name='d1_migrations'",
    'SELECT COUNT(*) AS n FROM items',
  ].join(';'),
);

const expectedMarketColumns = [
  'id',
  'type',
  'name',
  'description',
  'author',
  'icon',
  'tags',
  'content',
  'downloads',
  'views',
  'reports',
  'hidden',
  'ip_hash',
  'created_at',
  'edit_key_hash',
];
const marketColumns = rows(market, 0).map((row) => row.name);
const marketIndexes = rows(market, 1).map((row) => row.name);
const marketItems = scalar(market, 3, 'n');
const marketHasLedger = scalar(market, 2, 'n') === 1;
const marketLedger = marketHasLedger
  ? rows(
      remoteQuery(
        'dg-market',
        'apps/market/wrangler.jsonc',
        'SELECT name FROM d1_migrations ORDER BY id',
      ),
      0,
    ).map((row) => row.name)
  : [];

const auth = remoteQuery(
  '0xnullai-auth',
  'workers/auth/wrangler.jsonc',
  [
    'SELECT name FROM d1_migrations ORDER BY id',
    `SELECT COUNT(*) AS n FROM (
       SELECT object_key FROM user_photos GROUP BY object_key HAVING COUNT(*) > 1
     )`,
    `SELECT COUNT(*) AS n FROM (
       SELECT user_id FROM user_photos GROUP BY user_id HAVING COUNT(*) > 60
     )`,
    "SELECT COUNT(*) AS n FROM user_photos WHERE object_key IS NULL OR trim(object_key) = ''",
    `SELECT COUNT(*) AS n FROM (
       SELECT lower(email) AS normalized_email
       FROM users
       WHERE email IS NOT NULL
       GROUP BY lower(email)
       HAVING COUNT(*) > 1
     )`,
    'SELECT COUNT(*) AS n FROM user_photos',
    'SELECT COUNT(*) AS n FROM users',
  ].join(';'),
);

const expectedAuthLedger = ['0001_init.sql', '0002_user_data.sql', '0003_user_profile.sql'];
const authLedger = rows(auth, 0).map((row) => row.name);
const errors = [];
// Column order is not a compatibility boundary. Production added `views` later than
// the fresh-migration baseline, so PRAGMA reports it at the end even though both
// schemas expose the same named fields.
if (
  JSON.stringify([...marketColumns].sort()) !== JSON.stringify([...expectedMarketColumns].sort())
) {
  errors.push(`Market raw columns differ: ${JSON.stringify(marketColumns)}`);
}
if (JSON.stringify(marketIndexes) !== JSON.stringify(['idx_items_browse', 'idx_items_ip'])) {
  errors.push(`Market raw indexes differ: ${JSON.stringify(marketIndexes)}`);
}
const marketBaseline = ['0000_init.sql', '0001_add_edit_key.sql'];
if (marketLedger.length > 0 && JSON.stringify(marketLedger) !== JSON.stringify(marketBaseline)) {
  errors.push(`Market migration ledger differs: ${JSON.stringify(marketLedger)}`);
}
if (JSON.stringify(authLedger) !== JSON.stringify(expectedAuthLedger)) {
  errors.push(`Auth ledger differs: ${JSON.stringify(authLedger)}`);
}
if (scalar(auth, 1, 'n') !== 0) errors.push('Auth 0006 blocker: duplicate photo object_key');
if (scalar(auth, 2, 'n') !== 0) errors.push('Auth 0007 blocker: account with >60 photos');
if (scalar(auth, 3, 'n') !== 0) errors.push('Auth blocker: blank photo object_key');
if (scalar(auth, 4, 'n') !== 0) errors.push('Auth 0008 blocker: duplicate normalized email');

console.log(
  JSON.stringify(
    {
      ok: errors.length === 0,
      readOnly: true,
      market: {
        items: marketItems,
        columns: marketColumns,
        indexes: marketIndexes,
        migrations: marketLedger,
      },
      auth: {
        migrations: authLedger,
        users: scalar(auth, 6, 'n'),
        photos: scalar(auth, 5, 'n'),
      },
      errors,
      next: errors.length
        ? []
        : [
            'Back up both D1 databases.',
            marketLedger.length === 0
              ? 'Execute scripts/bootstrap-market-migration-ledger.sql against dg-market.'
              : 'Market baseline ledger already exists; do not execute the bootstrap script again.',
            'Apply Market 0002-0003 and Auth 0004-0009 migrations.',
            'Create 0xnullai-profile-photos before deploying Auth.',
            'Deploy chat, then auth, then market.',
          ],
    },
    null,
    2,
  ),
);
if (errors.length) process.exit(1);
