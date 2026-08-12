import { describe, expect, it } from 'vitest';
import { findBudgetViolations, isSourceFile, isTestFile } from './repository-files.mjs';

describe('repository structure helpers', () => {
  it('classifies source and test files without treating docs as code', () => {
    expect(isSourceFile('apps/control/src/App.tsx')).toBe(true);
    expect(isSourceFile('docs/architecture.md')).toBe(false);
    expect(isTestFile('packages/kit/core/src/core.test.ts')).toBe(true);
    expect(isTestFile('scripts/check.mjs')).toBe(false);
  });

  it('allows existing debt only up to its recorded ceiling', () => {
    const files = ['new.ts', 'legacy.ts', 'feature.test.ts'];
    const result = findBudgetViolations({
      files,
      lineCounts: { 'new.ts': 501, 'legacy.ts': 700, 'feature.test.ts': 801 },
      oversizedFiles: { 'legacy.ts': 700 },
      sourceMax: 500,
      testMax: 800,
    });

    expect(result).toEqual([
      { file: 'feature.test.ts', lines: 801, limit: 800 },
      { file: 'new.ts', lines: 501, limit: 500 },
    ]);
  });
});
