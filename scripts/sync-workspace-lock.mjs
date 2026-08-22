import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const LOCKFILE_PATH = 'package-lock.json';
const MANIFEST_FIELDS = [
  'name',
  'version',
  'license',
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'bin',
  'engines',
  'os',
  'cpu',
];

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function preserveKeyOrder(current, next) {
  if (!current || !next || Array.isArray(current) || Array.isArray(next)) return next;
  if (typeof current !== 'object' || typeof next !== 'object') return next;

  const ordered = {};
  for (const key of Object.keys(current)) {
    if (hasOwn(next, key)) ordered[key] = next[key];
  }
  for (const key of Object.keys(next)) {
    if (!hasOwn(ordered, key)) ordered[key] = next[key];
  }
  return ordered;
}

export function syncWorkspaceLock(lock, manifests) {
  const next = structuredClone(lock);
  if (!next.packages || typeof next.packages !== 'object') {
    throw new Error('package-lock.json has no packages map');
  }

  for (const [workspacePath, manifest] of manifests) {
    const entry = next.packages[workspacePath];
    if (!entry)
      throw new Error(`package-lock.json is missing workspace ${workspacePath || '<root>'}`);

    for (const field of MANIFEST_FIELDS) {
      if (hasOwn(manifest, field)) {
        entry[field] = preserveKeyOrder(entry[field], manifest[field]);
      } else {
        delete entry[field];
      }
    }
  }

  const root = manifests.get('');
  if (root) {
    next.name = root.name;
    next.version = root.version;
  }
  return next;
}

export function workspaceManifests(lock, cwd = process.cwd()) {
  const manifests = new Map();
  for (const workspacePath of Object.keys(lock.packages ?? {})) {
    if (workspacePath.includes('node_modules')) continue;
    const manifestPath = join(cwd, workspacePath, 'package.json');
    if (!existsSync(manifestPath)) continue;
    manifests.set(workspacePath, JSON.parse(readFileSync(manifestPath, 'utf8')));
  }
  return manifests;
}

function main() {
  const lock = JSON.parse(readFileSync(LOCKFILE_PATH, 'utf8'));
  const manifests = workspaceManifests(lock);
  const synced = syncWorkspaceLock(lock, manifests);
  writeFileSync(LOCKFILE_PATH, `${JSON.stringify(synced, null, 2)}\n`);
  console.log(`package-lock workspace metadata synced (${manifests.size} manifests)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
