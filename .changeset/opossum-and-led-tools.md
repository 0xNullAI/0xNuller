---
"@dg-kit/core": minor
"@dg-kit/tools": minor
---

Add `vibrate_start`/`vibrate_stop`/`vibrate_adjust` (Opossum vibrate controller) and `set_indicator_color` (paw-prints/civet-edging/opossum) tools to `createDefaultToolRegistry`. New `OpossumCommand` type and two additive `ToolExecutionPlan` variants (`'opossum'`, `'setIndicatorColor'`) in `@dg-kit/core`. `isDeviceToolName()` now also recognizes the four new tool names. Deliberately does not add `get_sensor_state`/`list_connected_devices` — those need live device-manager state the tools package doesn't have, so they're left as consumer-specific tools (same pattern DG-MCP already uses for `scan`/`connect`/`get_status`).
