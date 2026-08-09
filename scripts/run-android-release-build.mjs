import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(npm, ['run', 'verify:release']);
run(process.execPath, [
  fileURLToPath(new URL('prepare-android-release.mjs', import.meta.url)),
  '--release',
]);

const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
run(npm, ['run', 'android:build', '-w', '@0xnullai/android', '--', ...process.argv.slice(2)], {
  ...process.env,
  SOURCE_BUILD_ID: sourceCommit,
});
