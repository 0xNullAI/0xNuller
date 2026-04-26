---
'@dg-kit/protocol': minor
'@dg-kit/core': patch
'@dg-kit/waveforms': patch
'@dg-kit/tools': patch
'@dg-kit/transport-webbluetooth': patch
---

Add `setLimits(limitA, limitB)` to `BaseCoyoteProtocolAdapter` (and the V2 / V3 / facade implementations). On V3 it re-sends the BF init packet so the device enforces the new soft-limit; on V2 it updates state for the next tick to clamp against. Reducing a limit also clamps the current strength downward immediately. This unblocks DG-Chat's per-channel safety cap UI in Phase 4b.
