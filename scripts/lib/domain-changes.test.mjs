import { describe, expect, it } from 'vitest';
import { domainChanged } from './domain-changes.mjs';

// Each changed file maps to the CI domains it must (true) or must not (false) trigger.
const routing = {
  // Product-only UI does not run the npm package domains.
  'apps/control/src/App.tsx': { product: true, desktop: true, kit: false, mcp: false },
  // Kit changes fan out to Kit and both consumers.
  'packages/kit/core/src/index.ts': { product: true, desktop: true, kit: true, mcp: true },
  // MCP implementation changes stay in the MCP domain.
  'apps/mcp/src/cli.ts': { product: false, desktop: false, kit: false, mcp: true },
  // Worker-only production changes do not build native installers.
  'workers/llm-proxy/src/index.js': { product: true, desktop: false },
  'apps/chat/wrangler.jsonc': { product: true, desktop: false },
  'apps/voice/worker/index.ts': { product: true, desktop: false },
  // Shared product metadata rebuilds installers.
  'package.json': { desktop: true },
  'package-lock.json': { desktop: true },
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
