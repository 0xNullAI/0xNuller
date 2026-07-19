---
"@dg-kit/protocol": patch
---

Internal refactor: extract the GATT connect/disconnect sequence shared byte-for-byte by `PawPrintsSensorAdapter` and `CivetPressureSensorAdapter` (open write/notify characteristics, wire notification listener, run the V3-family handshake, best-effort battery read; and the matching teardown) into `connectSensorGatt`/`disconnectSensorGatt` in `gatt-utils.ts`. No public API or behavior change — each adapter's own state-transition semantics (e.g. paw-prints preserving the attempted device name on a failed connect, civet-edging auto-starting pressure streaming) are untouched.
