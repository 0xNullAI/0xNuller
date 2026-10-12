---
'dg-mcp': patch
---

Require `@modelcontextprotocol/sdk` 1.32.1 or newer, outside the range of GHSA-6qxp-vccf-f47h (OAuth client credentials sent to a server-chosen authorization server). DG-MCP only uses the stdio server transport, so the advisory never applied at run time; the new floor keeps audits of installs clean.
