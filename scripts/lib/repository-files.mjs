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

/**
 * Test layers, named by file suffix. A plain `name.test.ts` is a contract test: one
 * module's public behaviour against fakes at its boundary (a Worker route, a store, a
 * client). The other layers carry their name so they can be run and checked on their own.
 */
export const TEST_LAYERS = ['unit', 'contract', 'ui', 'integration'];

export function testLayer(file) {
  return file.match(/\.(unit|ui|integration)\.(?:test|spec)\.[cm]?[jt]sx?$/)?.[1] ?? 'contract';
}

// A unit test runs pure code: no mocks, network, storage, sockets, DOM or databases.
const impureUnitPattern =
  /vi\.(?:mock|fn|spyOn|stubGlobal|stubEnv|doMock|hoisted)\b|\bfetch\b|new (?:Response|Request|WebSocket)\b|sqlite|\bD1\b|env\.DB|localStorage|sessionStorage|indexedDB|@testing-library|miniflare|test-support|test-helpers|@vitest-environment|node:fs|node:child_process|document\.|window\./;

/** Returns why a test file does not fit its layer, or null when it fits. */
export function testLayerViolation(file, source) {
  const layer = testLayer(file);
  const rendersUi = source.includes('@testing-library');
  if (layer === 'unit' && impureUnitPattern.test(source))
    return 'unit tests must not use mocks, I/O, storage or the DOM; rename to .test or .ui.test';
  if (layer === 'ui' && !rendersUi) return 'ui tests render with @testing-library';
  if ((layer === 'contract' || layer === 'unit') && rendersUi)
    return 'tests that render with @testing-library belong in .ui.test or .integration.test';
  return null;
}
