import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectRepositoryFiles,
  countFileLines,
  findBudgetViolations,
  isSourceFile,
} from './lib/repository-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(
  readFileSync(path.join(root, 'config/architecture-budgets.json'), 'utf8'),
);
const changesetConfig = JSON.parse(readFileSync(path.join(root, '.changeset/config.json'), 'utf8'));
if (changesetConfig.privatePackages !== false) {
  console.error(
    'Changesets must not version private workspaces; product versions belong to the product release flow.',
  );
  process.exit(1);
}
const files = collectRepositoryFiles(root, ['android', 'apps', 'packages', 'scripts', 'workers']);
const sourceFiles = files.filter(isSourceFile);
const lineCounts = Object.fromEntries(
  sourceFiles.map((file) => [file, countFileLines(root, file)]),
);
const violations = findBudgetViolations({
  files: sourceFiles,
  lineCounts,
  oversizedFiles: config.oversizedFiles,
  sourceMax: config.sourceMaxLines,
  testMax: config.testMaxLines,
});

if (violations.length > 0) {
  console.error('Source size budget exceeded:');
  for (const { file, lines, limit } of violations) {
    console.error(`- ${file}: ${lines} lines (limit ${limit})`);
  }
  console.error('Split by responsibility; do not raise the budget for routine feature work.');
  process.exit(1);
}

const debt = Object.keys(config.oversizedFiles).filter((file) =>
  Object.prototype.hasOwnProperty.call(lineCounts, file),
);
console.log(
  `architecture budgets passed (${sourceFiles.length} source files, ${debt.length} recorded oversized files)`,
);
