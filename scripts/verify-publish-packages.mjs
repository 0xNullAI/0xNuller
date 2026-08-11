import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const packages = [
  ['@dg-kit/core', 'packages/kit/core'],
  ['@dg-kit/protocol', 'packages/kit/protocol'],
  ['@dg-kit/waveforms', 'packages/kit/waveforms'],
  ['@dg-kit/tools', 'packages/kit/tools'],
  ['@dg-kit/transport-webbluetooth', 'packages/kit/transport-webbluetooth'],
  ['@dg-kit/transport-tauri-blec', 'packages/kit/transport-tauri-blec'],
  ['@dg-kit/safety', 'packages/kit/safety'],
  ['dg-mcp', 'apps/mcp'],
];

function fail(message) {
  throw new Error(message);
}

for (const family of readdirSync('packages', { withFileTypes: true }).filter((entry) =>
  entry.isDirectory(),
)) {
  for (const entry of readdirSync(`packages/${family.name}`, { withFileTypes: true }).filter(
    (item) => item.isDirectory(),
  )) {
    const directory = `packages/${family.name}/${entry.name}`;
    const manifestPath = `${directory}/package.json`;
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!existsSync(`${directory}/README.md`)) fail(`${manifest.name}: README.md is missing`);
    if (typeof manifest.description !== 'string' || !manifest.description.trim()) {
      fail(`${manifest.name}: package description is missing`);
    }
    if (!manifest.main && !manifest.exports?.['.']) {
      fail(`${manifest.name}: package has no public root entry`);
    }
  }
}

for (const [name, directory] of packages) {
  const manifest = JSON.parse(readFileSync(`${directory}/package.json`, 'utf8'));
  if (manifest.name !== name) fail(`${directory}: expected package name ${name}`);
  if (manifest.private === true) fail(`${name}: publishable package cannot be private`);
  if (manifest.publishConfig?.access !== 'public')
    fail(`${name}: publishConfig.access must be public`);
  if (manifest.repository?.url !== 'git+https://github.com/0xNullAI/0xNuller.git') {
    fail(`${name}: repository must point to the unified 0xNuller repository`);
  }
  if (manifest.repository?.directory !== directory) {
    fail(`${name}: repository.directory must be ${directory}`);
  }
  if (!existsSync(`${directory}/README.md`)) fail(`${name}: README.md is missing`);

  const packed = JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--json', '--workspace', name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    }),
  )[0];
  const files = new Set(packed.files.map((entry) => entry.path));
  for (const required of ['package.json', 'README.md']) {
    if (!files.has(required)) fail(`${name}: tarball is missing ${required}`);
  }
  for (const target of [manifest.main, manifest.types, ...Object.values(manifest.bin ?? {})]) {
    if (target && !files.has(target.replace(/^\.\//, ''))) {
      fail(`${name}: tarball is missing declared entry ${target}`);
    }
  }
  const leakedTests = [...files].filter((file) =>
    /(?:^|\/)\w+\.test\.(?:js|d\.ts)(?:\.map)?$/.test(file),
  );
  if (leakedTests.length) fail(`${name}: tarball contains test output: ${leakedTests.join(', ')}`);
  console.log(`${packed.id}: ${packed.entryCount} files, ${packed.size} packed bytes`);
}

console.log('publish package dry-run verification passed');
