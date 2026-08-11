import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const baseFlag = process.argv.find((argument) => argument.startsWith('--base='));
const base = baseFlag?.slice('--base='.length);
if (!base) throw new Error('usage: node scripts/check-format-changed.mjs --base=<git revision>');

const output = execFileSync('git', [
  'diff',
  '--name-only',
  '--diff-filter=ACMR',
  '-z',
  base,
  'HEAD',
]);
const supported = /\.(?:[cm]?[jt]sx?|jsonc?|md|ya?ml|css|html)$/i;
const files = output
  .toString('utf8')
  .split('\0')
  .filter((path) => path && supported.test(path) && existsSync(path));

if (files.length === 0) {
  console.log(`no changed Prettier-supported files relative to ${base}`);
  process.exit(0);
}

const prettier =
  process.platform === 'win32' ? 'node_modules/.bin/prettier.cmd' : 'node_modules/.bin/prettier';
const result = spawnSync(prettier, ['--check', ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
