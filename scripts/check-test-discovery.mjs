import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRepositoryFiles, isTestFile } from './lib/repository-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expected = collectRepositoryFiles(root, ['android', 'apps', 'packages', 'scripts', 'workers'])
  .filter(isTestFile)
  .sort();
const result = spawnSync(process.execPath, ['scripts/run-vitest.mjs', 'list', '--filesOnly'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});
if (result.error) throw result.error;
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.stdout.write(result.stdout);
  process.exit(result.status ?? 1);
}

const discovered = result.stdout
  .split(/\r?\n/)
  .map((line) => line.match(/^\[[^\]]+\]\s+(.+\.(?:test|spec)\.[cm]?[jt]sx?)$/)?.[1])
  .filter(Boolean)
  .map((file) => path.relative(root, path.resolve(root, file)).split(path.sep).join('/'))
  .sort();
const discoveredSet = new Set(discovered);
const missing = expected.filter((file) => !discoveredSet.has(file));

if (missing.length > 0) {
  console.error('Tests not discovered by the root Vitest configuration:');
  for (const file of missing) console.error(`- ${file}`);
  process.exit(1);
}

console.log(`test discovery passed (${discovered.length} test files)`);
