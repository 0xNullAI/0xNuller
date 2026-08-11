import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const [target, ...targetArgs] = process.argv.slice(2);

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

if (target !== 'web' && target !== 'android') {
  console.error('Usage: node scripts/run-release-build.mjs <web|android> [build options]');
  process.exit(2);
}

run(npm, ['run', 'verify:release']);

if (git('status', '--porcelain', '--untracked-files=no')) {
  console.error('Release builds require a clean tracked worktree. Commit or revert changes first.');
  process.exit(2);
}

const releaseEnv = { ...process.env, SOURCE_BUILD_ID: git('rev-parse', 'HEAD') };

// Release builds must work in a fresh checkout. Applications import the Kit
// packages through their published dist entry points, so never rely on dist
// files left behind by an earlier local build or CI step.
run(npm, ['run', 'build:kit'], releaseEnv);

if (target === 'web') {
  run(npm, ['run', 'build', '-w', '@0xnullai/web'], releaseEnv);
} else {
  run(process.execPath, [
    fileURLToPath(new URL('prepare-android-release.mjs', import.meta.url)),
    '--release',
  ]);
  run(npm, ['run', 'android:build', '-w', '@0xnullai/android', '--', ...targetArgs], releaseEnv);
}
