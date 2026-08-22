---
'dg-mcp': patch
---

Require DG-Kit 1.16.2 so MCP installations receive the corrected Coyote V2 little-endian protocol implementation. MCP CLI and initialization metadata now read their version from the package manifest instead of reporting a stale hard-coded version.
