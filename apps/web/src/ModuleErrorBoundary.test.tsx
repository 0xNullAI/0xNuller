import { describe, expect, it } from 'vitest';
import { isStaleModuleLoadError } from './ModuleErrorBoundary';

describe('ModuleErrorBoundary', () => {
  it('recognizes stale Vite lazy chunks after a deployment', () => {
    expect(
      isStaleModuleLoadError(new Error('Failed to fetch dynamically imported module: /agent.js')),
    ).toBe(true);
    expect(isStaleModuleLoadError(new Error('ChunkLoadError: Loading chunk agent failed'))).toBe(
      true,
    );
  });

  it('does not mislabel ordinary Agent render errors as deployment cache errors', () => {
    expect(isStaleModuleLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
  });
});
