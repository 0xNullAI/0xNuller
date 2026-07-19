---
"@dg-kit/tools": minor
"@dg-kit/core": minor
---

Rename the five Coyote tools so their names state the capability (electric stimulation), symmetric with the Opossum `vibrate_*` family: `start`→`shock_start`（启动电击）, `stop`→`shock_stop`（停止电击）, `adjust_strength`→`shock_adjust`（调节电击强度）, `change_wave`→`shock_change_wave`（切换电击波形）, `burst`→`shock_burst`（电击脉冲）. Descriptions now state "仅适用于郊狼设备" and cross-reference the sibling device's tool (`负鼠设备请用 vibrate_*` / `郊狼设备请用 shock_start`), mirroring how the vibrate tools already pointed back.

Non-breaking: `ToolRegistry` gains alias support (`ToolHandler.aliases`) — the old names still resolve, execute, and rate-limit under the primary name, but `listDefinitions()` only advertises the new names, so LLMs and MCP clients only ever see `shock_*` while older hard-coded callers keep working. `@dg-kit/core`'s `isDeviceToolName` accepts both generations.
