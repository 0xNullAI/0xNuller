import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const changesetConfig = JSON.parse(readFileSync(path.join(root, '.changeset/config.json'), 'utf8'));
if (changesetConfig.privatePackages !== false) {
  console.error(
    'Changesets must not version private workspaces; product versions belong to the product release flow.',
  );
  process.exit(1);
}
console.log('architecture policy passed');
