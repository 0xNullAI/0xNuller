import { describe, expect, it } from 'vitest';
import { workspaceDomain, workspacesForDomain } from './workspace-domains.mjs';

describe('workspace release domains', () => {
  it('separates Product, DG-Kit, and DG-MCP ownership', () => {
    expect(workspaceDomain('apps/web/package.json')).toBe('product');
    expect(workspaceDomain('android/app/package.json')).toBe('product');
    expect(workspaceDomain('packages/platform/ui/package.json')).toBe('product');
    expect(workspaceDomain('packages/kit/core/package.json')).toBe('kit');
    expect(workspaceDomain('apps/mcp/package.json')).toBe('mcp');
  });

  it('does not place MCP in the Product workspace command', () => {
    const selected = workspacesForDomain(
      [
        { path: 'apps/web/package.json', manifest: { name: 'web' } },
        { path: 'apps/mcp/package.json', manifest: { name: 'mcp' } },
      ],
      'product',
    );
    expect(selected.map(({ manifest }) => manifest.name)).toEqual(['web']);
  });
});
