import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const usernameArg = process.argv.find((value) => value.startsWith('--username='));
const roleArg = process.argv.find((value) => value.startsWith('--role='));
const username = usernameArg?.slice('--username='.length).toLowerCase() ?? '';
const role = roleArg?.slice('--role='.length) ?? '';

if (
  !process.argv.includes('--remote-write') ||
  !process.argv.includes('--confirm=0xnullai-auth-account-role')
) {
  console.error(
    'Refusing remote role change without --remote-write --confirm=0xnullai-auth-account-role',
  );
  process.exit(2);
}
if (!/^[a-z0-9_-]{3,24}$/.test(username)) {
  console.error('Invalid --username; expected 3-24 lowercase letters, numbers, _ or -');
  process.exit(2);
}
if (role !== 'user' && role !== 'admin') {
  console.error('Invalid --role; expected user or admin');
  process.exit(2);
}

const wrangler = join(root, 'node_modules/.bin/wrangler');
const sql = `UPDATE users SET role = '${role}' WHERE username = '${username}' RETURNING id, username, role`;
const result = spawnSync(
  wrangler,
  [
    'd1',
    'execute',
    '0xnullai-auth',
    '--remote',
    '--config',
    'workers/auth/wrangler.jsonc',
    '--command',
    sql,
    '--json',
  ],
  { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);
if (result.status !== 0) {
  console.error(result.stderr || result.stdout);
  process.exit(result.status ?? 1);
}
const payload = JSON.parse(result.stdout);
const changed = payload[0]?.results ?? [];
if (changed.length !== 1) {
  console.error(`No account found for username ${username}`);
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, account: changed[0] }, null, 2));
