import { describe, expect, it } from 'vitest';
import {
  filesNeedingRetest,
  projectsForFiles,
  resolveTestProjects,
  selectRelatedFiles,
  touchesGlobalTestConfig,
} from './test-tiers.mjs';

describe('tiered test selection', () => {
  it('keeps source/config files while ignoring docs and generated output', () => {
    expect(
      selectRelatedFiles([
        './apps/control/src/App.tsx',
        'apps/control/src/App.tsx',
        'docs/testing.md',
        'packages/kit/core/package.json',
        'apps/control/dist/index.js',
      ]),
    ).toEqual(['apps/control/src/App.tsx', 'packages/kit/core/package.json']);
  });

  it('escalates changes to shared Vitest configuration and setup', () => {
    expect(touchesGlobalTestConfig(['apps/control/src/App.tsx'])).toBe(false);
    expect(touchesGlobalTestConfig(['apps/control/vitest.config.ts'])).toBe(true);
    expect(touchesGlobalTestConfig(['test/setup/jsdom-gaps.ts'])).toBe(true);
  });

  it('maps friendly module names to Vitest project names', () => {
    expect(resolveTestProjects(['chat', 'control', 'chat'])).toEqual(['0xnullai-chat', 'control']);
  });

  it('caps changed-file analysis to the projects that own those files', () => {
    expect(
      projectsForFiles([
        'packages/kit/core/src/index.ts',
        'apps/chat/src/App.tsx',
        'apps/chat/src/lib/protocol.ts',
        'scripts/run-tiered-tests.mjs',
      ]),
    ).toEqual(['0xnullai-chat', 'kit', 'tooling']);
  });

  it('reruns only files changed since the last successful quick tier', () => {
    expect(
      filesNeedingRetest(
        { 'a.ts': 'same', 'b.ts': 'new', 'c.ts': 'added' },
        { 'a.ts': 'same', 'b.ts': 'old' },
      ),
    ).toEqual(['b.ts', 'c.ts']);
  });
});
