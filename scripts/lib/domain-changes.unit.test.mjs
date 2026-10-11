import { describe, expect, it } from 'vitest';
import { domainChanged } from './domain-changes.mjs';

// Each changed file maps to the CI domains it must (true) or must not (false) trigger.
const routing = {
  // Product-only UI does not run the npm package domains.
  'apps/control/src/App.tsx': { product: true, kit: false, mcp: false },
  // Kit changes fan out to Kit and both consumers.
  'packages/kit/core/src/index.ts': { product: true, kit: true, mcp: true },
  // MCP implementation changes stay in the MCP domain.
  'apps/mcp/src/cli.ts': { product: false, kit: false, mcp: true },
  // Worker-only production changes stay in the product domain.
  'workers/llm-proxy/src/index.js': { product: true, kit: false, mcp: false },
  'apps/chat/wrangler.jsonc': { product: true, kit: false, mcp: false },
  // Shared metadata verifies every domain.
  'package.json': { product: true, kit: true, mcp: true },
  'package-lock.json': { product: true, kit: true, mcp: true },
};

describe('CI domain routing', () => {
  it.each(
    Object.entries(routing).flatMap(([file, domains]) =>
      Object.entries(domains).map(([domain, expected]) => [file, domain, expected]),
    ),
  )('routes %s to %s: %s', (file, domain, expected) => {
    expect(domainChanged(domain, [file])).toBe(expected);
  });
});
