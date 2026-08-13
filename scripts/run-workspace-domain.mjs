import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { workspacesForDomain } from './lib/workspace-domains.mjs';

const [command, domain] = process.argv.slice(2);
if (!command || !['product', 'kit', 'mcp'].includes(domain)) {
  console.error('Usage: node scripts/run-workspace-domain.mjs <npm-script> <product|kit|mcp>');
  process.exit(2);
}

const manifests = [];
for (const parent of [
  'apps',
  'android',
  'workers',
  'packages/agent',
  'packages/kit',
  'packages/platform',
]) {
  if (!existsSync(parent)) continue;
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = `${parent}/${entry.name}/package.json`;
    if (existsSync(path))
      manifests.push({ path, manifest: JSON.parse(readFileSync(path, 'utf8')) });
  }
}

const selected = workspacesForDomain(manifests, domain).filter(
  ({ manifest }) => typeof manifest.scripts?.[command] === 'string',
);
for (const { manifest } of selected) {
  console.log(`\n[${domain}] ${manifest.name}: ${command}`);
  const result = spawnSync('npm', ['run', command, '--workspace', manifest.name], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
