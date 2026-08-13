import { readdirSync } from 'node:fs';
import path from 'node:path';

const ignoredDirectories = new Set([
  '.astro',
  '.git',
  '.wrangler',
  'dist',
  'gen',
  'node_modules',
  'target',
]);

const sourcePattern = /\.(?:[cm]?[jt]sx?|rs)$/;
const testPattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

export function collectRepositoryFiles(root, directories) {
  const result = [];

  function visit(relativeDirectory) {
    const absoluteDirectory = path.join(root, relativeDirectory);
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) visit(relativePath);
      else result.push(relativePath.split(path.sep).join('/'));
    }
  }

  for (const directory of directories) visit(directory);
  return result.sort();
}

export function isSourceFile(file) {
  return sourcePattern.test(file);
}

export function isTestFile(file) {
  return testPattern.test(file);
}
