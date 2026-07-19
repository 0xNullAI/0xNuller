---
"@dg-kit/core": minor
"@dg-kit/protocol": minor
"@dg-kit/tools": minor
---

Full byte-level audit of all five 47L12x-family protocol docs (Coyote V2/V3, paw-prints, civet-edging, opossum) against this implementation surfaced a real bug: the Opossum vibration controller's `setIntensity()`/`vibrate_start` only ever wrote the 0xB3 "displayed strength" command. The actual motor drive comes from 0xB0, a 20-byte waveform packet that must be re-sent every 100ms — since `OpossumVibrateAdapter` never streamed it, the device reported itself as "on" while the motor never received anything to play.

`OpossumVibrateAdapter` now drives an internal 100ms tick loop (via the new shared `ProtocolTickLoop`, extracted from `BaseCoyoteProtocolAdapter`'s previously-inline Worker/`setInterval` mechanism) that streams 0xB0 automatically whenever either channel's intensity is above zero, and writes one final all-zero frame when both return to zero. `setIntensity`/`adjustIntensity`/`emergencyStop`'s external contract is unchanged — this is a fire-and-forget fix, not a new calling convention.

Two more real bugs fixed on the same device: the connect-time handshake's init packet double-duties under Opossum's opcode table as "disable button-press reporting," so 0xD0 button events never arrived — `onConnected` now explicitly re-enables reporting. And the 0xB2 screen-sync command existed but was never called, so the on-device strength display never matched actual state — it's now sent after every `setIntensity()` call and every incoming 0xB3 notification.

New capability: named vibration-rhythm presets (`constant`, `pulse`, `wave`, `ramp`, `heartbeat`, exported as `OPOSSUM_VIBRATION_PATTERNS`) drive the B0 stream's per-channel envelope independently of intensity. `OpossumVibrateAdapter.setVibrationPattern(channel, pattern)` is the new adapter-level API; `OpossumCommand`'s `vibrateStart` variant gains an optional `pattern?: OpossumVibrationPatternName` field, and `@dg-kit/tools`'s `vibrate_start` tool accepts a matching optional `pattern` enum parameter. Arbitrary caller-supplied envelopes are deliberately not exposed to tool callers — only the named presets — so an LLM can change rhythm without being able to submit an unpleasant or startling raw amplitude sequence.

Also from the same audit, on paw-prints (爪印): the doc requires writing a "no trigger mode" 0x50 command immediately after connecting or the device may proactively drop the BLE connection — `onConnected` now sends it. And 0x51 status notifications (the device's only battery source; it has no dedicated battery GATT service) now fold their battery byte into `SensorState.battery`, which previously stayed frozen at 0.

Internal refactors, no behavior change: `WaveCursor<TFrame, TStep>` (generic per-channel frame-queue stepping, extracted from `BaseCoyoteProtocolAdapter.advanceWaveStep`) is now shared between Coyote's wave stepper and Opossum's new pattern cursor. `clampNumber` (extracted to `gatt-utils.ts`) replaces duplicated clamp logic in both adapters. `OpossumVibrateAdapter.onConnected` now reuses the shared `connectSensorGatt`/`disconnectSensorGatt` sequence instead of its own byte-for-byte-identical duplicate.

Small fix: the V3-family connect handshake's MTU request moves from 140 to 144, matching the opossum doc's specific recommendation (harmless best-effort negotiation for the rest of the family too).
