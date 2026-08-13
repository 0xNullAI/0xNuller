import { describe, expect, it } from 'vitest';
import { domainChanged } from './domain-changes.mjs';

describe('CI domain routing', () => {
  it('routes product-only UI without running npm package domains', () => {
    const files = ['apps/control/src/App.tsx'];
    expect(domainChanged('product', files)).toBe(true);
    expect(domainChanged('kit', files)).toBe(false);
    expect(domainChanged('mcp', files)).toBe(false);
  });

  it('fans Kit changes out to Kit and both consumers', () => {
    const files = ['packages/kit/core/src/index.ts'];
    expect(domainChanged('product', files)).toBe(true);
    expect(domainChanged('kit', files)).toBe(true);
    expect(domainChanged('mcp', files)).toBe(true);
  });

  it('keeps MCP implementation changes in the MCP domain', () => {
    const files = ['apps/mcp/src/cli.ts'];
    expect(domainChanged('product', files)).toBe(false);
    expect(domainChanged('kit', files)).toBe(false);
    expect(domainChanged('mcp', files)).toBe(true);
  });
});
