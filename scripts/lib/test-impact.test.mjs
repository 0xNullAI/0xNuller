import { describe, expect, it } from 'vitest';
import {
  buildReverseDependencyGraph,
  planAffectedTests,
  reverseDependencyClosure,
  workspaceForFile,
} from './test-impact.mjs';

const workspaces = [
  { name: '@dg-kit/core', dir: 'packages/kit/core', manifest: {} },
  {
    name: '@0xnullai/device-runtime',
    dir: 'packages/platform/device-runtime',
    manifest: { dependencies: { '@dg-kit/core': '^1.0.0' } },
  },
  {
    name: '0xnullai-chat',
    dir: 'apps/chat',
    manifest: { dependencies: { '@0xnullai/device-runtime': '*' } },
  },
  {
    name: '@0xnullai/web',
    dir: 'apps/web',
    manifest: {},
  },
  { name: 'dg-mcp', dir: 'apps/mcp', manifest: { dependencies: { '@dg-kit/core': '^1.0.0' } } },
];

describe('affected test planning', () => {
  it('maps a file to its nearest workspace', () => {
    expect(workspaceForFile('packages/kit/core/src/index.ts', workspaces)?.name).toBe(
      '@dg-kit/core',
    );
  });

  it('still maps a deleted source path through its surviving workspace manifest', () => {
    expect(workspaceForFile('apps/chat/src/removed-feature.ts', workspaces)?.name).toBe(
      '0xnullai-chat',
    );
  });

  it('computes transitive reverse dependencies across workspace layers', () => {
    const graph = buildReverseDependencyGraph(workspaces);
    expect([...reverseDependencyClosure(['@dg-kit/core'], graph)].sort()).toEqual([
      '0xnullai-chat',
      '@0xnullai/device-runtime',
      '@0xnullai/web',
      '@dg-kit/core',
      'dg-mcp',
    ]);
  });

  it('models source-composed shell consumers absent from package manifests', () => {
    const graph = buildReverseDependencyGraph(workspaces);
    expect(graph.get('0xnullai-chat')).toContain('@0xnullai/web');
  });

  it('includes consumer projects when a shared package changes', () => {
    expect(planAffectedTests(['packages/kit/core/src/index.ts'], workspaces)).toMatchObject({
      kind: 'affected',
      projects: ['0xnullai-chat', 'dg-mcp', 'kit', 'platform', 'web'],
    });
  });

  it('can limit the closure to a CI responsibility domain without losing product consumers', () => {
    expect(
      planAffectedTests(['packages/kit/core/src/index.ts'], workspaces, { domain: 'product' }),
    ).toMatchObject({ projects: ['0xnullai-chat', 'platform', 'web'] });
  });

  it('keeps a leaf application change focused', () => {
    expect(planAffectedTests(['apps/chat/src/App.tsx'], workspaces)).toMatchObject({
      kind: 'affected',
      projects: ['0xnullai-chat', 'web'],
    });
  });

  it('escalates global configuration and unmapped runtime files conservatively', () => {
    expect(planAffectedTests(['vitest.config.ts'], workspaces)).toMatchObject({ kind: 'full' });
    expect(planAffectedTests(['brand/runtime-policy.ts'], workspaces)).toMatchObject({
      kind: 'full',
      reason: 'unmapped runtime file: brand/runtime-policy.ts',
    });
  });

  it('does not spend test time on documentation-only changes', () => {
    expect(planAffectedTests(['docs/testing.md'], workspaces)).toMatchObject({
      kind: 'affected',
      projects: [],
    });
  });
});
