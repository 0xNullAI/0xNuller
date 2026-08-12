import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function pendingChangesetFiles(entries) {
  return entries
    .filter((entry) => entry.endsWith('.md') && entry !== 'README.md')
    .sort((left, right) => left.localeCompare(right));
}

export function verifyChangesetsConsumed(entries) {
  const pending = pendingChangesetFiles(entries);
  if (pending.length > 0) {
    throw new Error(
      [
        'Pending changesets must be consumed by the npm Version PR before dev can merge to main:',
        ...pending.map((file) => `- .changeset/${file}`),
      ].join('\n'),
    );
  }
  return 'changesets consumed: no pending npm release notes';
}

function main() {
  try {
    console.log(verifyChangesetsConsumed(readdirSync('.changeset')));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
