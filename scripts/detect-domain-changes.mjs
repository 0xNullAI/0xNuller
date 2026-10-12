import { execFileSync } from 'node:child_process';
import { domainChanged } from './lib/domain-changes.mjs';

const [domain, base, head = 'HEAD'] = process.argv.slice(2);
if (!domain || !base) {
  console.error('Usage: node scripts/detect-domain-changes.mjs <product|kit|mcp> <base> [head]');
  process.exit(2);
}
const files = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', base, head], {
  encoding: 'utf8',
})
  .split(/\r?\n/)
  .filter(Boolean);
const changed = domainChanged(domain, files);
console.log(`changed=${changed}`);
if (process.env.GITHUB_OUTPUT) {
  await import('node:fs').then(({ appendFileSync }) =>
    appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`, 'utf8'),
  );
}
