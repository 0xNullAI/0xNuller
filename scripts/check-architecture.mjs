import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeRepository,
  compareWithBaseline,
  formatViolation,
} from './lib/architecture-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const changesetConfig = JSON.parse(readFileSync(path.join(root, '.changeset/config.json'), 'utf8'));
if (changesetConfig.privatePackages !== false) {
  console.error(
    'Changesets must not version private workspaces; product versions belong to the product release flow.',
  );
  process.exit(1);
}

const baselinePath = path.join(root, 'scripts/architecture-baseline.json');
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const violations = analyzeRepository(root);
const { existing, newViolations, resolved } = compareWithBaseline(violations, baseline.violations);

if (existing.length > 0) {
  console.warn(`Architecture debt baseline (${existing.length} existing violation(s)):`);
  for (const violation of existing) console.warn(`- ${formatViolation(violation)}`);
}

if (resolved.length > 0) {
  console.error(
    '\nArchitecture baseline contains resolved violation(s); remove them from the baseline:',
  );
  for (const violation of resolved) console.error(`- ${formatViolation(violation)}`);
}

if (newViolations.length > 0) {
  console.error('\nNew architecture violation(s):');
  for (const violation of newViolations) console.error(`- ${formatViolation(violation)}`);
}

if (newViolations.length > 0 || resolved.length > 0) process.exit(1);

console.log(`architecture policy passed (${existing.length} baseline violation(s) remain)`);
