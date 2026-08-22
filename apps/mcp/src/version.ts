import { readFileSync } from 'node:fs';

interface PackageManifest {
  version?: unknown;
}

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageManifest;

if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  throw new Error('apps/mcp/package.json must contain a stable semantic version');
}

/** The published package version is the single source for all MCP version reporting. */
export const DG_MCP_VERSION = manifest.version;
