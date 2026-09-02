# @dg-kit/protocol

## 1.16.4

### Patch Changes

- Preserve unavailable auxiliary-device battery readings instead of reporting a false 0%.
  - @dg-kit/core@1.16.4

## 1.16.3

### Patch Changes

- @dg-kit/core@1.16.3

## 1.16.2

### Patch Changes

- 71e06ae: ⚠️ **Bug fix — Coyote V2 byte order.**

  The Coyote 2.0 (D-LAB ESTIM) wire format is little-endian for the 3-byte
  strength packet (1504) and the 3-byte waveform packets (1505/1506), but the
  adapters previously emitted big-endian bytes. On real hardware a single
  channel read as effectively silent while dual-channel output spiked near full
  power — neither matches the requested strength.

  Both encoders now send least-significant byte first, and strength
  notifications are parsed with the same little-endian layout. If you were
  working around the old byte order, remove that workaround after upgrading:
  the wire bytes now match the device. Verified on a real Coyote 2.0 device.
  - @dg-kit/core@1.16.2

## 1.16.1

### Patch Changes

- 8341b9a: Read DG-Lab battery levels from the standard BLE Battery Service and preserve an unavailable reading instead of reporting a false 0%.

  Recover from Chromium's `GATT Server is disconnected` service-discovery race by reconnecting before retrying the protocol handshake.
  - @dg-kit/core@1.16.1

## 1.16.0

### Patch Changes

- @dg-kit/core@1.16.0

## 1.15.0

### Patch Changes

- Updated dependencies [d29dd12]
  - @dg-kit/core@1.15.0

## 1.14.0

- Add the shared `RequestedDevice` transport contract.

## 1.13.0

### Minor Changes

- 249673d: Closed a browser/Tauri asymmetry: `@dg-kit/transport-tauri-blec` already shipped `TauriBlecOpossumClient`/`TauriBlecPawPrintsClient`/`TauriBlecCivetEdgingClient`, but `@dg-kit/transport-webbluetooth` only had a Coyote client — every browser consumer (DG-Agent, DG-Chat) had to hand-roll its own Opossum/sensor client against the bare protocol adapters. This release adds the missing pieces so both transports share one set of contracts:
  - `@dg-kit/core` gains `SensorDeviceClient<TReading>` and `DEVICE_KIND_DISPLAY_NAME`.
  - `@dg-kit/protocol` gains `OpossumClient`, `OpossumCommandResult`, `PawPrintsClient`, `CivetEdgingClient` (they reference `OpossumState`/`PawPrintsReading`/`CivetPressureReading`, which live here, not in core).
  - `@dg-kit/transport-webbluetooth` gains `WebBluetoothOpossumClient`, `WebBluetoothSensorClient` (+ `WebBluetoothPawPrintsClient`/`WebBluetoothCivetEdgingClient`), the `connectAuxDevice`/`attachAuxDevice`/`disconnectAuxDevice` helpers, and the per-kind `*_REQUEST_DEVICE_OPTIONS` scan filters.
  - `@dg-kit/transport-tauri-blec`'s `OpossumCommandResult` is now re-exported from `@dg-kit/protocol` instead of being declared a second time (its own export is unchanged, so this is non-breaking).

  Also fixes a real bug found while consolidating: `TauriBlecOpossumClient.execute()` hand-rolled its own `OpossumCommand` switch and only handled `vibrateStart`/`vibrateStop`/`vibrateAdjust` — `vibrateSetPattern` and `vibrateBurst` silently resolved as a no-op on Tauri/Android (the browser client was never affected; it already delegated to the adapter). `execute()` now delegates to `OpossumVibrateAdapter.execute()`, the same single source of truth `@dg-kit/protocol` introduced in 1.12.0 for exactly this class of bug.

### Patch Changes

- Updated dependencies [249673d]
  - @dg-kit/core@1.13.0

## 1.12.0

### Minor Changes

- 88b2d46: `OpossumVibrateAdapter` gains `execute(command: OpossumCommand): Promise<OpossumState>` — the vibrate-side counterpart of `CoyoteProtocolAdapter.execute()`. Every consumer previously hand-rolled its own `OpossumCommand`→adapter-method switch; DG-MCP's copy silently no-op'd on `vibrateBurst`/`vibrateSetPattern` (added in 1.10.0) because nothing forced it to stay exhaustive. `execute()` is now the single source of truth for that mapping, with a `never` check so a future `OpossumCommand` variant fails to compile here instead of silently doing nothing downstream.

### Patch Changes

- @dg-kit/core@1.12.0

## 1.11.0

### Minor Changes

- f341ecc: `OpossumState` gains optional `patternA`/`patternB` — the named rhythm preset each channel's B0 stream currently follows ('constant' on connect), so UIs and the LLM status block can show which rhythm is running the same way Coyote's state already reports `currentWaveA/B`. `setVibrationPattern` now accepts a preset name (`'pulse'` etc.) in addition to a raw envelope array; named calls stamp the state field, raw-array calls blank it (custom envelope, no name to report), and the change now emits a state update.

### Patch Changes

- @dg-kit/core@1.11.0

## 1.10.0

### Minor Changes

- 0e6657b: Complete the Coyote↔Opossum tool symmetry (5 tools each): new `vibrate_change_pattern`（切换振动节奏）switches a channel's rhythm preset without touching intensity (the vibrate counterpart of `shock_change_wave`), and new `vibrate_burst`（振动脉冲）briefly raises a channel to a target intensity then auto-restores (the counterpart of `shock_burst`).

  `OpossumVibrateAdapter` gains `vibrateBurst(channel, intensity, durationMs)` with the exact semantics of Coyote's `runBurst`: the restore target is `min(current, previous)` so an intervening stop or manual decrease is never pushed back up by a late-firing timer; a second burst on the same channel supersedes the first's restore; `emergencyStop()` and `onDisconnected()` cancel pending restores. `OpossumCommand` gains `vibrateSetPattern` and `vibrateBurst` variants, and `isDeviceToolName` recognizes the two new tool names.

  `vibrate_start` keeps its optional `pattern` parameter for cold starts, but its description now points mid-run rhythm changes at `vibrate_change_pattern`; `shock_change_wave`'s cross-reference likewise now names the dedicated tool instead of the old re-call-vibrate_start workaround.

### Patch Changes

- Updated dependencies [0e6657b]
  - @dg-kit/core@1.10.0

## 1.9.0

### Patch Changes

- Updated dependencies [5909ca0]
  - @dg-kit/core@1.9.0

## 1.8.1

### Patch Changes

- f85b923: `OPOSSUM_VIBRATION_PATTERNS` was added in 1.8.0 but never re-exported from the package's public `index.ts` — every downstream consumer importing from `@dg-kit/protocol` (rather than reaching into `dist/opossum.js` directly) couldn't actually access it despite it being documented as part of the new vibration-pattern API. Fixed; added a public-API-surface test to catch this class of gap going forward.
  - @dg-kit/core@1.8.1

## 1.8.0

### Minor Changes

- 500648d: Full byte-level audit of all five 47L12x-family protocol docs (Coyote V2/V3, paw-prints, civet-edging, opossum) against this implementation surfaced a real bug: the Opossum vibration controller's `setIntensity()`/`vibrate_start` only ever wrote the 0xB3 "displayed strength" command. The actual motor drive comes from 0xB0, a 20-byte waveform packet that must be re-sent every 100ms — since `OpossumVibrateAdapter` never streamed it, the device reported itself as "on" while the motor never received anything to play.

  `OpossumVibrateAdapter` now drives an internal 100ms tick loop (via the new shared `ProtocolTickLoop`, extracted from `BaseCoyoteProtocolAdapter`'s previously-inline Worker/`setInterval` mechanism) that streams 0xB0 automatically whenever either channel's intensity is above zero, and writes one final all-zero frame when both return to zero. `setIntensity`/`adjustIntensity`/`emergencyStop`'s external contract is unchanged — this is a fire-and-forget fix, not a new calling convention.

  Two more real bugs fixed on the same device: the connect-time handshake's init packet double-duties under Opossum's opcode table as "disable button-press reporting," so 0xD0 button events never arrived — `onConnected` now explicitly re-enables reporting. And the 0xB2 screen-sync command existed but was never called, so the on-device strength display never matched actual state — it's now sent after every `setIntensity()` call and every incoming 0xB3 notification.

  New capability: named vibration-rhythm presets (`constant`, `pulse`, `wave`, `ramp`, `heartbeat`, exported as `OPOSSUM_VIBRATION_PATTERNS`) drive the B0 stream's per-channel envelope independently of intensity. `OpossumVibrateAdapter.setVibrationPattern(channel, pattern)` is the new adapter-level API; `OpossumCommand`'s `vibrateStart` variant gains an optional `pattern?: OpossumVibrationPatternName` field, and `@dg-kit/tools`'s `vibrate_start` tool accepts a matching optional `pattern` enum parameter. Arbitrary caller-supplied envelopes are deliberately not exposed to tool callers — only the named presets — so an LLM can change rhythm without being able to submit an unpleasant or startling raw amplitude sequence.

  Also from the same audit, on paw-prints (爪印): the doc requires writing a "no trigger mode" 0x50 command immediately after connecting or the device may proactively drop the BLE connection — `onConnected` now sends it. And 0x51 status notifications (the device's only battery source; it has no dedicated battery GATT service) now fold their battery byte into `SensorState.battery`, which previously stayed frozen at 0.

  Internal refactors, no behavior change: `WaveCursor<TFrame, TStep>` (generic per-channel frame-queue stepping, extracted from `BaseCoyoteProtocolAdapter.advanceWaveStep`) is now shared between Coyote's wave stepper and Opossum's new pattern cursor. `clampNumber` (extracted to `gatt-utils.ts`) replaces duplicated clamp logic in both adapters. `OpossumVibrateAdapter.onConnected` now reuses the shared `connectSensorGatt`/`disconnectSensorGatt` sequence instead of its own byte-for-byte-identical duplicate.

  Small fix: the V3-family connect handshake's MTU request moves from 140 to 144, matching the opossum doc's specific recommendation (harmless best-effort negotiation for the rest of the family too).

### Patch Changes

- Updated dependencies [500648d]
  - @dg-kit/core@1.8.0

## 1.7.1

### Patch Changes

- c1a9719: Fix a real "当前环境不支持连接郊狼设备" / `NotFoundError: No Services matching UUID ... found in Device` failure on first-time Web Bluetooth pairing: `WebBluetoothDeviceClient.connectDevice()` called `getPrimaryService()` immediately after `gatt.connect()` resolved, with no retry — but Chrome's Web Bluetooth can resolve `gatt.connect()` before its internal GATT service cache is guaranteed populated, especially on a fresh pairing.

  `@dg-kit/transport-tauri-blec` already had a `runWithGattReadyRetry` helper for the identical race on Android (plugin-blec's `connect()` has the same "resolves before service discovery" gap). That retry logic moves to `@dg-kit/protocol` (transport-agnostic — it only wraps a `() => Promise<void>` attempt with a delay+retry loop matching known transient-error message patterns) and is now also applied to `WebBluetoothDeviceClient.connectDevice()`. `@dg-kit/transport-tauri-blec`'s own `gatt-ready.ts` becomes a re-export for backward compatibility.

  New `WebBluetoothDeviceClientOptions.gattReadyRetryOptions` lets callers tune the retry (mainly for tests); defaults match the Tauri side (300ms initial delay, 3s total retry budget, 250ms interval).
  - @dg-kit/core@1.7.1

## 1.7.0

### Patch Changes

- @dg-kit/core@1.7.0

## 1.6.1

### Patch Changes

- fad835c: Internal refactor: extract the GATT connect/disconnect sequence shared byte-for-byte by `PawPrintsSensorAdapter` and `CivetPressureSensorAdapter` (open write/notify characteristics, wire notification listener, run the V3-family handshake, best-effort battery read; and the matching teardown) into `connectSensorGatt`/`disconnectSensorGatt` in `gatt-utils.ts`. No public API or behavior change — each adapter's own state-transition semantics (e.g. paw-prints preserving the attempted device name on a failed connect, civet-edging auto-starting pressure streaming) are untouched.
  - @dg-kit/core@1.6.1

## 1.6.0

### Patch Changes

- @dg-kit/core@1.6.0

## 1.5.0

### Patch Changes

- @dg-kit/core@1.5.0

## 1.4.0

### Minor Changes

- 9f49180: Add `DeviceKind`, `SensorState`, and `detectDeviceKind()` — the shared foundation for supporting the other 47L12x-family devices (paw-prints sensor, civet-edging sensor, opossum vibrate controller) alongside Coyote. Also adds `WebBluetoothSensorAdapter<TReading>`, a narrower adapter contract for event/telemetry-pushing sensor devices, and `DG_LAB_REQUEST_DEVICE_OPTIONS`, a scan filter covering all known device prefixes. All additive — existing Coyote-only `DeviceState`/`DeviceCommand`/`CoyoteProtocolAdapter` are unchanged.

### Patch Changes

- d14a78a: Clamp the 47L12x-family indicator LED color byte to the documented 0-7 discrete enum (0=off, 1=yellow, 2=red, 3=purple, 4=blue, 5=cyan, 6=green, 7=white) in `paw-prints.setLedSolid`/`setLedBlink`, `civet-edging.setIndicatorColor`/`startPressureReporting`/`stopPressureReporting`, and `opossum.setLed`. Previously these accepted any 0-255 byte with no defined meaning past 7, which let a naive 0-255 color picker (or a malformed remote-control message) send an undefined value to real hardware.
- 3cc9922: Multi-agent code review of the paw-prints/civet-edging/opossum/handshake work found and fixed several real bugs before publish:
  - **The three new device adapters never ran the connect-time handshake** PR #3 added for Coyote V3 — since they share the exact same 47L12x GATT skeleton, this reproduced the same "device won't respond" symptom for newer firmware on paw-prints/civet-edging/opossum too. Extracted the handshake (and the write-fallback-chain helper, previously copy-pasted four times) into a shared `gatt-utils.ts` module all four adapters now use.
  - **`CoyoteProtocolAdapter` (the facade) silently routed non-Coyote devices to the V3 adapter** — a scanned paw-prints/civet-edging/opossum device fed through the facade would get Coyote-shaped B0/BF writes. Now throws a clear error via `detectDeviceKind()` instead of misrouting.
  - **`transport-webbluetooth`'s default scan filter** still only listed Coyote name prefixes, so civet-edging/opossum devices wouldn't appear in the Web Bluetooth chooser unless a caller explicitly passed `DG_LAB_REQUEST_DEVICE_OPTIONS`. Now defaults to the broader filter.
  - **`transport-tauri-blec`'s `forceTeardown()` (disconnect racing an in-flight reconnect) skipped the emergency-stop-before-disconnect safety step** that a normal `disconnect()` does — a user disconnecting mid-reconnect could leave the device running at its last commanded strength with no way to remotely stop it.
  - Civet-edging's `set_indicator_color` tool support had no way to change the LED color without forcing the pressure stream on or off as a side effect (there's no separate color-only opcode) — added `setIndicatorColor()`, which preserves the current streaming state.
  - Opossum's connect-failure cleanup path left a live GATT notification subscription dangling if a step after `startNotifications()` threw. Added `adjustIntensity()` so `vibrate_adjust`-style callers get an atomic read-modify-write instead of composing `getState()` + `setIntensity()` themselves (avoids a lost-update race between two concurrent adjusts).

- 4af7814: Fix Coyote V3 devices failing to respond after an official-app firmware update. Devices now receive the same connect-time handshake the official app sends (init packet on the write characteristic, best-effort subscription to legacy/OTA notify channels, MTU bump to 140) before normal B0/BF control writes begin. Adds an optional `requestMTU` hook to `BluetoothRemoteGATTServerLike` for transports that support MTU negotiation.
- Updated dependencies [9f49180]
- Updated dependencies [9f49180]
- Updated dependencies [3cc9922]
  - @dg-kit/core@1.4.0

## 1.3.0

### Patch Changes

- @dg-kit/core@1.3.0

## 1.2.1

### Patch Changes

- @dg-kit/core@1.2.1

## 1.2.0

### Patch Changes

- ea1d12d: Harden `@dg-kit/transport-tauri-blec` for Android shell consumers. Three behaviour fixes; all are additive and require no consumer code changes.
  - **`TauriBlecDeviceClient.disconnect()` now zeroes the device before tearing down BLE.** Mirrors `transport-webbluetooth`'s flow: `protocol.emergencyStop()` runs first so a user-initiated disconnect never leaves Coyote V3 running at its last commanded strength (V3 retains state across drops). Previously a `disconnect()` would just close the GATT link.
  - **GATT-shim `gatt.disconnect()` now fires `gattserverdisconnected` synchronously.** Matches Web Bluetooth observable behaviour. plugin-blec's `disconnect()` is async and not all platforms invoke its `onDisconnect` callback on a user-initiated tear-down, so the shim now fires the event itself and dedupes against a later plugin callback.
  - **Scan result change detection covers name / connection state / services**, not only RSSI. Picker UIs now refresh when devices flip `isConnected` mid-scan or surface late service UUIDs.

  No public API additions; existing test suite extended from 43 to 47 tests.

- Updated dependencies [ea1d12d]
  - @dg-kit/core@1.2.0

## 1.1.0

### Minor Changes

- 22de7a5: Add `@dg-kit/transport-tauri-blec` — Tauri 2 BLE `DeviceClient` backed by `@mnlphlp/plugin-blec`. Mirrors `transport-webbluetooth` for non-browser runtimes (Tauri Android primary target). Synthesizes `BluetoothRemoteGATT*Like` shapes from plugin-blec's flat API so the Coyote protocol layer is unchanged.

### Patch Changes

- Updated dependencies [22de7a5]
  - @dg-kit/core@1.1.0

## 1.0.1

### Patch Changes

- b189d86: CI / infrastructure release — no API or behaviour changes.
  - Unified PR / issue templates + dependabot config
  - release-guard workflow gates main entry on version bump
  - npm provenance enabled on publish

- Updated dependencies [b189d86]
  - @dg-kit/core@1.0.1

## 1.0.0

### Major Changes

- 340e495: First stable release. Three downstream consumers — DG-Agent (browser AI controller), DG-Chat (P2P multi-user room), and DG-MCP (Model Context Protocol server) — have all migrated onto the published `@dg-kit/*` packages and verified end-to-end against real Coyote 2.0 / 3.0 hardware. The public API (DeviceCommand shape, BaseCoyoteProtocolAdapter / WebBluetoothProtocolAdapter interfaces, ToolRegistry, RateLimitPolicy, WaveformLibrary, design-segment primitives, .pulse parser) is now considered stable; breaking changes will only ship as 2.x.

### Patch Changes

- Updated dependencies [340e495]
  - @dg-kit/core@1.0.0

## 0.2.0

### Minor Changes

- 55017d6: Add `setLimits(limitA, limitB)` to `BaseCoyoteProtocolAdapter` (and the V2 / V3 / facade implementations). On V3 it re-sends the BF init packet so the device enforces the new soft-limit; on V2 it updates state for the next tick to clamp against. Reducing a limit also clamps the current strength downward immediately. This unblocks DG-Chat's per-channel safety cap UI in Phase 4b.

### Patch Changes

- Updated dependencies [55017d6]
  - @dg-kit/core@0.2.0

## 0.1.1

### Patch Changes

- 39d6853: Fix published `package.json` so `main` / `types` / `exports` point to `dist/`. The previous 0.1.0 tarballs had `main: src/index.ts` from the unsupported `publishConfig.main` override pattern, which broke `import` resolution for downstream consumers. Local dev now requires `npm run build` before `typecheck` / `test` (wired automatically via `pretypecheck` / `pretest`).
- Updated dependencies [39d6853]
  - @dg-kit/core@0.1.1

## 0.1.0

### Minor Changes

- 85c5805: Initial public release. Carved out from DG-Agent's internal packages and made runtime-agnostic so DG-Agent, DG-MCP, and DG-Chat can share a single source of truth for the device protocol, waveforms, and tool definitions.

### Patch Changes

- Updated dependencies [85c5805]
  - @dg-kit/core@0.1.0
