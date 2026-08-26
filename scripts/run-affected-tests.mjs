import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planAffectedTests, TEST_DOMAINS } from './lib/test-impact.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const domain = valueFor('--domain') ?? 'all';
const prepared = args.includes('--prepared');

if (!TEST_DOMAINS.includes(domain)) {
  console.error(`Unknown test domain: ${domain}`);
  process.exit(2);
}

function valueFor(flag) {
  const argument = args.find((item) => item.startsWith(`${flag}=`));
  return argument?.slice(flag.length + 1);
}

function gitLines(gitArgs) {
  return execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function discoverWorkspaces() {
  const workspaces = [];
  for (const parent of [
    'apps',
    'android',
    'workers',
    'packages/agent',
    'packages/kit',
    'packages/platform',
  ]) {
    const absoluteParent = path.join(root, parent);
    if (!existsSync(absoluteParent)) continue;
    for (const entry of readdirSync(absoluteParent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = `${parent}/${entry.name}`;
      const manifestPath = path.join(root, dir, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (typeof manifest.name === 'string')
        workspaces.push({ name: manifest.name, dir, manifest });
    }
  }
  return workspaces;
}

function changedFiles() {
  const base = valueFor('--base') ?? process.env.BASE_SHA ?? 'origin/dev';
  const head = valueFor('--head') ?? 'HEAD';
  try {
    const committed = gitLines(['diff', '--name-only', '--diff-filter=ACMRD', `${base}...${head}`]);
    const worktree = gitLines(['diff', '--name-only', '--diff-filter=ACMRD', head]);
    const untracked = gitLines(['ls-files', '--others', '--exclude-standard']);
    return { files: [...new Set([...committed, ...worktree, ...untracked])], base, head };
  } catch (error) {
    console.warn(
      `Unable to diff ${base}...${head}; conservatively selecting the full ${domain} suite.`,
    );
    return { files: ['package-lock.json'], base, head, error };
  }
}

const changeSet = changedFiles();
const plan = planAffectedTests(changeSet.files, discoverWorkspaces(), { domain });
console.log(
  `[affected] ${changeSet.base}...${changeSet.head}: ${changeSet.files.length} changed file(s); ` +
    `${plan.kind} ${domain} selection (${plan.reason}).`,
);

if (plan.projects.length === 0) {
  console.log('[affected] No test-bearing changes in this responsibility domain.');
  process.exit(0);
}

console.log(`[affected] Vitest projects: ${plan.projects.join(', ')}`);
if (!prepared && plan.projects.some((project) => project !== 'tooling')) {
  console.log('[affected] Preparing DG-Kit once for downstream workspace imports.');
  run('npm', ['run', 'build:kit']);
}
run(process.execPath, [
  'scripts/run-vitest.mjs',
  'run',
  ...plan.projects.map((project) => `--project=${project}`),
  '--passWithNoTests',
]);
