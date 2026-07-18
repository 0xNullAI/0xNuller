---
"@dg-kit/core": patch
"@dg-kit/protocol": patch
"@dg-kit/transport-webbluetooth": patch
"@dg-kit/transport-tauri-blec": patch
---

Multi-agent code review of the paw-prints/civet-edging/opossum/handshake work found and fixed several real bugs before publish:

- **The three new device adapters never ran the connect-time handshake** PR #3 added for Coyote V3 — since they share the exact same 47L12x GATT skeleton, this reproduced the same "device won't respond" symptom for newer firmware on paw-prints/civet-edging/opossum too. Extracted the handshake (and the write-fallback-chain helper, previously copy-pasted four times) into a shared `gatt-utils.ts` module all four adapters now use.
- **`CoyoteProtocolAdapter` (the facade) silently routed non-Coyote devices to the V3 adapter** — a scanned paw-prints/civet-edging/opossum device fed through the facade would get Coyote-shaped B0/BF writes. Now throws a clear error via `detectDeviceKind()` instead of misrouting.
- **`transport-webbluetooth`'s default scan filter** still only listed Coyote name prefixes, so civet-edging/opossum devices wouldn't appear in the Web Bluetooth chooser unless a caller explicitly passed `DG_LAB_REQUEST_DEVICE_OPTIONS`. Now defaults to the broader filter.
- **`transport-tauri-blec`'s `forceTeardown()` (disconnect racing an in-flight reconnect) skipped the emergency-stop-before-disconnect safety step** that a normal `disconnect()` does — a user disconnecting mid-reconnect could leave the device running at its last commanded strength with no way to remotely stop it.
- Civet-edging's `set_indicator_color` tool support had no way to change the LED color without forcing the pressure stream on or off as a side effect (there's no separate color-only opcode) — added `setIndicatorColor()`, which preserves the current streaming state.
- Opossum's connect-failure cleanup path left a live GATT notification subscription dangling if a step after `startNotifications()` threw. Added `adjustIntensity()` so `vibrate_adjust`-style callers get an atomic read-modify-write instead of composing `getState()` + `setIntensity()` themselves (avoids a lost-update race between two concurrent adjusts).
