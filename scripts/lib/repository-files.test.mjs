import { describe, expect, it } from 'vitest';
import { isSourceFile, isTestFile, testLayer, testLayerViolation } from './repository-files.mjs';

// Built from parts so this file's own text does not match the layer rules it tests.
const rendering = `import { render } from '@testing${'-'}library/react';`;
const mocking = `vi.${'mock'}("./b")`;

describe('repository structure helpers', () => {
  it('classifies source and test files without treating docs as code', () => {
    expect(isSourceFile('apps/control/src/App.tsx')).toBe(true);
    expect(isSourceFile('docs/architecture.md')).toBe(false);
    expect(isTestFile('packages/kit/core/src/core.test.ts')).toBe(true);
    expect(isTestFile('scripts/check.mjs')).toBe(false);
  });

  it.each([
    ['a/b.unit.test.ts', "import { x } from './b';", 'unit', false],
    ['a/b.unit.test.ts', mocking, 'unit', true],
    ['a/b.ui.test.tsx', rendering, 'ui', false],
    ['a/b.ui.test.tsx', "import { x } from './b';", 'ui', true],
    ['a/b.test.ts', rendering, 'contract', true],
    ['a/b.integration.test.tsx', rendering, 'integration', false],
  ])('checks the layer named by %s', (file, source, layer, violates) => {
    expect(testLayer(file)).toBe(layer);
    expect(testLayerViolation(file, source) !== null).toBe(violates);
  });
});
