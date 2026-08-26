import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projectsForDomain, TEST_DOMAINS } from './lib/test-impact.mjs';

const args = process.argv.slice(2);
const domainArgument = args.find((argument) => argument.startsWith('--domain='));
const domain = domainArgument?.slice('--domain='.length);
if (domainArgument && !TEST_DOMAINS.includes(domain)) {
  console.error(`Unknown test domain: ${domain}`);
  process.exit(2);
}
const vitestArgs = args.filter((argument) => argument !== domainArgument);
if (domain) {
  vitestArgs.push(...projectsForDomain(domain).map((project) => `--project=${project}`));
}

// Node's experimental Web Storage is process-wide and, when enabled without a
// persistence file, its localStorage getter emits a warning as jsdom setup probes it.
// Tests require jsdom's isolated in-memory storage instead. NODE_OPTIONS propagates
// the official opt-out to Vitest's runner and every worker on all CI platforms;
// unlike --localstorage-file, it creates no shared state or temporary-path dependency.
const webStorageOptOut = '--no-experimental-webstorage';
const existingNodeOptions = process.env.NODE_OPTIONS?.trim();
const nodeOptions = existingNodeOptions?.includes(webStorageOptOut)
  ? existingNodeOptions
  : [existingNodeOptions, webStorageOptOut].filter(Boolean).join(' ');
const vitestEntrypoint = fileURLToPath(
  new URL('../node_modules/vitest/vitest.mjs', import.meta.url),
);

const child = spawn(process.execPath, [vitestEntrypoint, ...vitestArgs], {
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
  stdio: 'inherit',
});

child.once('error', (error) => {
  console.error('Failed to start Vitest:', error);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
