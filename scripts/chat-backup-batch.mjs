import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { exerciseChatBackup } from './chat-backup-exercise.mjs';

const FORMAT = '0xnullai-chat-backup-batch-v1';
const COMPONENTS = ['auth-d1', 'chat', 'auth-media'];

async function componentFingerprint(directory) {
  const entries = [];
  async function walk(folder, prefix = '') {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(folder, entry.name);
      if (entry.isDirectory()) await walk(full, path);
      else if (entry.isFile()) {
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(full)) hash.update(chunk);
        if (!(await lstat(full)).isFile())
          throw new Error('Backup component changed during fingerprint');
        entries.push([path, hash.digest('hex')]);
      } else throw new Error('Backup component contains a non-regular file');
    }
  }
  await walk(directory);
  if (entries.length === 0) throw new Error('Backup component is empty');
  const hash = createHash('sha256');
  for (const [path, digest] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    hash.update(JSON.stringify([path, digest]));
    hash.update('\n');
  }
  return hash.digest('hex');
}

async function componentFingerprints(root) {
  return Object.fromEntries(
    await Promise.all(
      COMPONENTS.map(async (component) => [
        component,
        await componentFingerprint(join(root, component)),
      ]),
    ),
  );
}

/** Reserve a new directory before capture. A failed run remains visibly incomplete. */
export async function captureChatBackupBatch(
  destination,
  passphrase,
  captures,
  exercise = exerciseChatBackup,
) {
  const root = resolve(destination);
  await mkdir(root, { mode: 0o700 });
  await writeFile(
    join(root, 'batch-state.json'),
    JSON.stringify({
      format: FORMAT,
      state: 'capturing',
      startedAt: new Date().toISOString(),
      components: COMPONENTS,
    }),
    { flag: 'wx', mode: 0o600 },
  );
  await captures.d1(join(root, COMPONENTS[0]));
  await captures.chat(join(root, COMPONENTS[1]));
  await captures.authMedia(join(root, COMPONENTS[2]));
  const d1Postflight = captures.d1Postflight
    ? await captures.d1Postflight(join(root, COMPONENTS[0]))
    : { state: 'not-run' };
  const fingerprints = await componentFingerprints(root);
  const report = await exercise(
    ...COMPONENTS.map((component) => join(root, component)),
    passphrase,
  );
  if (JSON.stringify(await componentFingerprints(root)) !== JSON.stringify(fingerprints))
    throw new Error('Backup batch component changed during exercise');
  const result = {
    format: FORMAT,
    state:
      report.passed && d1Postflight.state === 'chat-tables-matched'
        ? 'verified'
        : 'captured-unverified',
    finishedAt: new Date().toISOString(),
    fingerprints,
    d1Postflight,
    report,
  };
  await writeFile(join(root, 'batch-result.json'), JSON.stringify(result), {
    flag: 'wx',
    mode: 0o600,
  });
  return result;
}

/** Re-run the recovery structure exercise; a status file alone proves nothing. */
export async function verifyChatBackupBatch(directory, passphrase, exercise = exerciseChatBackup) {
  const root = resolve(directory);
  const state = JSON.parse(await readFile(join(root, 'batch-state.json'), 'utf8'));
  if (
    state.format !== FORMAT ||
    state.state !== 'capturing' ||
    JSON.stringify(state.components) !== JSON.stringify(COMPONENTS)
  )
    throw new Error('Invalid backup batch state');
  let saved;
  try {
    saved = JSON.parse(await readFile(join(root, 'batch-result.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Backup batch is incomplete', { cause: error });
    throw error;
  }
  if (saved.format !== FORMAT || !['verified', 'captured-unverified'].includes(saved.state))
    throw new Error('Backup batch is incomplete');
  if (!['chat-tables-matched', 'not-run'].includes(saved.d1Postflight?.state))
    throw new Error('Invalid Auth D1 postflight state');
  const fingerprints = await componentFingerprints(root);
  if (JSON.stringify(fingerprints) !== JSON.stringify(saved.fingerprints))
    throw new Error('Backup batch component changed');
  const report = await exercise(
    ...COMPONENTS.map((component) => join(root, component)),
    passphrase,
  );
  if (JSON.stringify(report) !== JSON.stringify(saved.report))
    throw new Error('Backup batch recovery report changed');
  const verifiedState =
    report.passed && saved.d1Postflight.state === 'chat-tables-matched'
      ? 'verified'
      : 'captured-unverified';
  if (saved.state !== verifiedState)
    throw new Error('Backup batch state disagrees with recovery report');
  return { state: verifiedState, report, d1Postflight: saved.d1Postflight };
}
