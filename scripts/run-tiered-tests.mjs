import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  filesNeedingRetest,
  isGlobalTestFile,
  projectsForFiles,
  resolveTestProjects,
  selectRelatedFiles,
  TEST_PROJECT_ALIASES,
  touchesGlobalTestConfig,
} from './lib/test-tiers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const statePath = path.join(root, '.tmp/test-tier-state.json');
const [mode = 'changed', ...rawArgs] = process.argv.slice(2);

function gitLines(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
}

function changedFiles(base) {
  const tracked = base
    ? gitLines(['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`])
    : [];
  const worktree = gitLines(['diff', '--name-only', '--diff-filter=ACMR', 'HEAD']);
  const untracked = gitLines(['ls-files', '--others', '--exclude-standard']);
  return [...new Set([...tracked, ...worktree, ...untracked])];
}

function runVitest(args) {
  const result = spawnSync(process.execPath, ['scripts/run-vitest.mjs', ...args], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function parseBase(args) {
  const baseFlag = args.find((argument) => argument.startsWith('--base='));
  return baseFlag?.slice('--base='.length);
}

function hashFiles(files) {
  return Object.fromEntries(
    files.map((file) => [
      file,
      createHash('sha256')
        .update(readFileSync(path.join(root, file)))
        .digest('hex'),
    ]),
  );
}

function readPreviousHashes() {
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    return state.version === 1 ? state.files : {};
  } catch {
    return {};
  }
}

function saveHashes(files) {
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(
    statePath,
    `${JSON.stringify({ version: 1, files: hashFiles(files) }, null, 2)}\n`,
    'utf8',
  );
}

if (mode === 'changed' || mode === 'watch') {
  const base = parseBase(rawArgs);
  const changed = changedFiles(base);
  const allRelated = selectRelatedFiles(changed)
    .filter((file) => !isGlobalTestFile(file))
    .filter((file) => existsSync(path.join(root, file)));
  const currentHashes = hashFiles(allRelated);
  const useCache = mode === 'changed' && !base && !rawArgs.includes('--all');
  const related = useCache ? filesNeedingRetest(currentHashes, readPreviousHashes()) : allRelated;
  if (related.length === 0) {
    console.log('No files changed since the last successful quick test.');
    process.exit(0);
  }

  if (touchesGlobalTestConfig(changed)) {
    console.warn(
      'Shared test configuration changed. The quick tier will test product changes only; run test:full before handoff.',
    );
  }
  console.log(
    `Running tests related to ${related.length} newly changed file(s)` +
      (useCache ? ' (use --all to retest the whole worktree).' : '.'),
  );
  const projects = projectsForFiles(related);
  const status = runVitest([
    'related',
    ...related,
    ...projects.map((project) => `--project=${project}`),
    ...(mode === 'changed' ? ['--run'] : []),
    '--passWithNoTests',
  ]);
  if (status === 0 && mode === 'changed') saveHashes(allRelated);
  process.exit(status);
}

if (mode === 'related') {
  const related = selectRelatedFiles(rawArgs);
  if (related.length === 0) {
    console.error('Usage: npm run test:related -- <source-or-test-file> [...]');
    process.exit(2);
  }
  process.exit(runVitest(['related', ...related, '--run', '--passWithNoTests']));
}

if (mode === 'module') {
  if (rawArgs.length === 0) {
    console.error(
      `Usage: npm run test:module -- <${Object.keys(TEST_PROJECT_ALIASES).join('|')}> [...]`,
    );
    process.exit(2);
  }
  const projects = resolveTestProjects(rawArgs);
  process.exit(
    runVitest(['run', ...projects.map((project) => `--project=${project}`), '--passWithNoTests']),
  );
}

console.error(`Unknown test tier: ${mode}`);
process.exit(2);
