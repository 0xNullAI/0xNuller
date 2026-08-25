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

function assertOutsideStaticClosure(startKey, forbiddenSource, description) {
  for (const key of staticClosure(startKey)) {
    const record = manifest[key];
    if (key.includes(forbiddenSource) || record?.src?.includes(forbiddenSource)) {
      fail(`${description} is eagerly reachable from ${manifest[startKey]?.src ?? startKey}`);
    }
  }
}

const entry = findRecord((record) => record.isEntry === true, 'the browser entry');
const agent = findRecord((record) => record.src === 'src/modules/agent.tsx', 'the Agent route');
const piRuntime = findRecord(
  (record) => record.src?.includes('packages/agent/providers-pi-http/src/index.ts'),
  'the lazy pi-ai runtime',
);
const mistralRuntime = findRecord(
  (record) => record.src?.endsWith('/pi-ai/dist/api/mistral-conversations.js'),
  'the Mistral runtime',
);
const buttplugWasm = findRecord(
  (record) => record.src?.includes('buttplug-wasm-blob/dist/buttplug_wasm-'),
  'the Buttplug WASM payload',
);

if (entry) {
  assertOutsideStaticClosure(entry[0], 'providers-pi-http/src/index.ts', 'pi-ai runtime');
  assertOutsideStaticClosure(entry[0], 'buttplug_wasm-', 'Buttplug WASM');
}
if (agent) {
  assertOutsideStaticClosure(agent[0], 'providers-pi-http/src/index.ts', 'pi-ai runtime');
}
if (piRuntime) {
  const providerFactories = Object.entries(manifest).filter(([, record]) =>
    record.src?.includes('/pi-ai/dist/providers/'),
  );
  if (providerFactories.length === 0) fail('manifest has no pi-ai provider factories');
  for (const [key, record] of providerFactories) {
    if (record.isDynamicEntry !== true) fail(`${record.src} is not a dynamic entry`);
    assertOutsideStaticClosure(piRuntime[0], record.src, `provider factory ${record.name ?? key}`);
  }
}
for (const [match, description] of [
  [piRuntime, 'pi-ai runtime'],
  [mistralRuntime, 'Mistral runtime'],
  [buttplugWasm, 'Buttplug WASM'],
]) {
  if (match && match[1].isDynamicEntry !== true) fail(`${description} is not a dynamic entry`);
}

for (const file of readdirSync(path.join(webDist, 'assets'))) {
  if (!file.endsWith('.js')) continue;
  const source = readFileSync(path.join(webDist, 'assets', file));
  if (source.includes(Buffer.from('node:fs'))) fail(`${file} still contains a node:fs import`);
}

function assetMetric(match) {
  if (!match) return 'missing';
  const source = readFileSync(path.join(webDist, match[1].file));
  return `${(source.byteLength / 1000).toFixed(2)} kB / ${(gzipSync(source).byteLength / 1000).toFixed(2)} kB gzip`;
}

if (!process.exitCode) {
  console.log('web bundle verification passed');
  console.log(`  pi-ai runtime: ${assetMetric(piRuntime)} (on first pi-ai turn/model inspection)`);
  console.log(`  Mistral runtime: ${assetMetric(mistralRuntime)} (on first Mistral request)`);
  console.log(`  Buttplug WASM: ${assetMetric(buttplugWasm)} (on embedded-device connection)`);
}
