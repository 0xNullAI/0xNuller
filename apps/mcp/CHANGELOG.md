# dg-mcp

## 1.2.3

### Patch Changes

- b352a4b: Require DG-Kit 1.16.2 so MCP installations receive the corrected Coyote V2 little-endian protocol implementation. MCP CLI and initialization metadata now read their version from the package manifest instead of reporting a stale hard-coded version.

## 1.2.2

### Patch Changes

- Separate npm package publishing from 0xNuller platform GitHub Releases.

## 1.2.1

### Patch Changes

- 15f74ff: Publish DG-MCP through the same Changesets and npm-production workflow as DG-Kit.

## 1.2.0

- Move the maintained package source to the 0xNuller monorepo.
- Use DG-Kit 1.14.0 with unified multi-device transport and safety contracts.
- Keep legacy tool aliases while exposing the current device-specific tool names.
