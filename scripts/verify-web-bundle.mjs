import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDist = path.join(root, 'apps/web/dist');
const manifestPath = path.join(webDist, '.vite/manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

function fail(message) {
  console.error(`web bundle verification failed: ${message}`);
  process.exitCode = 1;
}

function findRecord(predicate, description) {
  const match = Object.entries(manifest).find(([key, record]) => predicate(record, key));
  if (!match) fail(`manifest is missing ${description}`);
  return match;
}

function staticClosure(startKey) {
  const visited = new Set();
  const pending = [startKey];
  while (pending.length > 0) {
    const key = pending.pop();
    if (!key || visited.has(key)) continue;
    visited.add(key);
    for (const dependency of manifest[key]?.imports ?? []) pending.push(dependency);
  }
  return visited;
}

const entry = findRecord((record) => record.isEntry === true, 'the browser entry');
const bootstrap = findRecord(
  (record) => record.src === 'src/bootstrap.tsx',
  'the mandatory application bootstrap',
);

for (const file of readdirSync(path.join(webDist, 'assets'))) {
  // The generic-device backend was removed; its WASM payload must not return.
  if (file.includes('buttplug')) fail(`${file} is a removed Buttplug asset`);
  if (!file.endsWith('.js')) continue;
  const source = readFileSync(path.join(webDist, 'assets', file));
  if (source.includes(Buffer.from('node:fs'))) fail(`${file} still contains a node:fs import`);
}

if (entry && bootstrap) {
  const initial = new Set([...staticClosure(entry[0]), ...staticClosure(bootstrap[0])]);
  let raw = 0;
  let gzip = 0;
  for (const key of initial) {
    const bytes = readFileSync(path.join(webDist, manifest[key].file));
    raw += bytes.length;
    gzip += gzipSync(bytes).length;
  }
  console.log(
    `  initial JS (including mandatory bootstrap): ${initial.size} files, ${raw} bytes / ${gzip} bytes gzip`,
  );
  if (gzip > 300_000) fail(`initial JS exceeds the 300 kB gzip budget (${gzip} bytes)`);
  for (const source of [
    'src/settings/SettingsPanel.tsx',
    'src/profile/ProfileDialog.tsx',
    'src/ContactsDialog.tsx',
  ]) {
    const dialog = findRecord((record) => record.src === source, source);
    if (dialog && initial.has(dialog[0])) fail(`${source} is eagerly loaded`);
  }
}

if (!process.exitCode) {
  console.log('web bundle verification passed');
}
