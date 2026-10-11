import { describe, expect, it } from 'vitest';
import { isSourceFile, isTestFile } from './repository-files.mjs';

describe('repository structure helpers', () => {
  it('classifies source and test files without treating docs as code', () => {
    expect(isSourceFile('apps/control/src/App.tsx')).toBe(true);
    expect(isSourceFile('docs/architecture.md')).toBe(false);
    expect(isTestFile('packages/kit/core/src/core.test.ts')).toBe(true);
    expect(isTestFile('scripts/check.mjs')).toBe(false);
  });
});
