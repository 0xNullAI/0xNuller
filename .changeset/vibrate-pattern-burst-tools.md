---
"@dg-kit/core": minor
"@dg-kit/protocol": minor
"@dg-kit/tools": minor
---

Complete the Coyote↔Opossum tool symmetry (5 tools each): new `vibrate_change_pattern`（切换振动节奏）switches a channel's rhythm preset without touching intensity (the vibrate counterpart of `shock_change_wave`), and new `vibrate_burst`（振动脉冲）briefly raises a channel to a target intensity then auto-restores (the counterpart of `shock_burst`).

`OpossumVibrateAdapter` gains `vibrateBurst(channel, intensity, durationMs)` with the exact semantics of Coyote's `runBurst`: the restore target is `min(current, previous)` so an intervening stop or manual decrease is never pushed back up by a late-firing timer; a second burst on the same channel supersedes the first's restore; `emergencyStop()` and `onDisconnected()` cancel pending restores. `OpossumCommand` gains `vibrateSetPattern` and `vibrateBurst` variants, and `isDeviceToolName` recognizes the two new tool names.

`vibrate_start` keeps its optional `pattern` parameter for cold starts, but its description now points mid-run rhythm changes at `vibrate_change_pattern`; `shock_change_wave`'s cross-reference likewise now names the dedicated tool instead of the old re-call-vibrate_start workaround.
