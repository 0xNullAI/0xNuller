# @dg-kit/core

## 1.4.0

### Minor Changes

- 9f49180: Add `DeviceKind`, `SensorState`, and `detectDeviceKind()` — the shared foundation for supporting the other 47L12x-family devices (paw-prints sensor, civet-edging sensor, opossum vibrate controller) alongside Coyote. Also adds `WebBluetoothSensorAdapter<TReading>`, a narrower adapter contract for event/telemetry-pushing sensor devices, and `DG_LAB_REQUEST_DEVICE_OPTIONS`, a scan filter covering all known device prefixes. All additive — existing Coyote-only `DeviceState`/`DeviceCommand`/`CoyoteProtocolAdapter` are unchanged.
- 9f49180: Add `vibrate_start`/`vibrate_stop`/`vibrate_adjust` (Opossum vibrate controller) and `set_indicator_color` (paw-prints/civet-edging/opossum) tools to `createDefaultToolRegistry`. New `OpossumCommand` type and two additive `ToolExecutionPlan` variants (`'opossum'`, `'setIndicatorColor'`) in `@dg-kit/core`. `isDeviceToolName()` now also recognizes the four new tool names. Deliberately does not add `get_sensor_state`/`list_connected_devices` — those need live device-manager state the tools package doesn't have, so they're left as consumer-specific tools (same pattern DG-MCP already uses for `scan`/`connect`/`get_status`).

### Patch Changes

- 3cc9922: Multi-agent code review of the paw-prints/civet-edging/opossum/handshake work found and fixed several real bugs before publish:
  - **The three new device adapters never ran the connect-time handshake** PR #3 added for Coyote V3 — since they share the exact same 47L12x GATT skeleton, this reproduced the same "device won't respond" symptom for newer firmware on paw-prints/civet-edging/opossum too. Extracted the handshake (and the write-fallback-chain helper, previously copy-pasted four times) into a shared `gatt-utils.ts` module all four adapters now use.
  - **`CoyoteProtocolAdapter` (the facade) silently routed non-Coyote devices to the V3 adapter** — a scanned paw-prints/civet-edging/opossum device fed through the facade would get Coyote-shaped B0/BF writes. Now throws a clear error via `detectDeviceKind()` instead of misrouting.
  - **`transport-webbluetooth`'s default scan filter** still only listed Coyote name prefixes, so civet-edging/opossum devices wouldn't appear in the Web Bluetooth chooser unless a caller explicitly passed `DG_LAB_REQUEST_DEVICE_OPTIONS`. Now defaults to the broader filter.
  - **`transport-tauri-blec`'s `forceTeardown()` (disconnect racing an in-flight reconnect) skipped the emergency-stop-before-disconnect safety step** that a normal `disconnect()` does — a user disconnecting mid-reconnect could leave the device running at its last commanded strength with no way to remotely stop it.
  - Civet-edging's `set_indicator_color` tool support had no way to change the LED color without forcing the pressure stream on or off as a side effect (there's no separate color-only opcode) — added `setIndicatorColor()`, which preserves the current streaming state.
  - Opossum's connect-failure cleanup path left a live GATT notification subscription dangling if a step after `startNotifications()` threw. Added `adjustIntensity()` so `vibrate_adjust`-style callers get an atomic read-modify-write instead of composing `getState()` + `setIntensity()` themselves (avoids a lost-update race between two concurrent adjusts).

## 1.3.0

## 1.2.1

## 1.2.0

### Patch Changes

- ea1d12d: Harden `@dg-kit/transport-tauri-blec` for Android shell consumers. Three behaviour fixes; all are additive and require no consumer code changes.
  - **`TauriBlecDeviceClient.disconnect()` now zeroes the device before tearing down BLE.** Mirrors `transport-webbluetooth`'s flow: `protocol.emergencyStop()` runs first so a user-initiated disconnect never leaves Coyote V3 running at its last commanded strength (V3 retains state across drops). Previously a `disconnect()` would just close the GATT link.
  - **GATT-shim `gatt.disconnect()` now fires `gattserverdisconnected` synchronously.** Matches Web Bluetooth observable behaviour. plugin-blec's `disconnect()` is async and not all platforms invoke its `onDisconnect` callback on a user-initiated tear-down, so the shim now fires the event itself and dedupes against a later plugin callback.
  - **Scan result change detection covers name / connection state / services**, not only RSSI. Picker UIs now refresh when devices flip `isConnected` mid-scan or surface late service UUIDs.

  No public API additions; existing test suite extended from 43 to 47 tests.

## 1.1.0

### Minor Changes

- 22de7a5: Add `@dg-kit/transport-tauri-blec` — Tauri 2 BLE `DeviceClient` backed by `@mnlphlp/plugin-blec`. Mirrors `transport-webbluetooth` for non-browser runtimes (Tauri Android primary target). Synthesizes `BluetoothRemoteGATT*Like` shapes from plugin-blec's flat API so the Coyote protocol layer is unchanged.

## 1.0.1

### Patch Changes

- b189d86: CI / infrastructure release — no API or behaviour changes.
  - Unified PR / issue templates + dependabot config
  - release-guard workflow gates main entry on version bump
  - npm provenance enabled on publish

## 1.0.0

### Major Changes

- 340e495: First stable release. Three downstream consumers — DG-Agent (browser AI controller), DG-Chat (P2P multi-user room), and DG-MCP (Model Context Protocol server) — have all migrated onto the published `@dg-kit/*` packages and verified end-to-end against real Coyote 2.0 / 3.0 hardware. The public API (DeviceCommand shape, BaseCoyoteProtocolAdapter / WebBluetoothProtocolAdapter interfaces, ToolRegistry, RateLimitPolicy, WaveformLibrary, design-segment primitives, .pulse parser) is now considered stable; breaking changes will only ship as 2.x.

## 0.2.0

### Patch Changes

- 55017d6: Add `setLimits(limitA, limitB)` to `BaseCoyoteProtocolAdapter` (and the V2 / V3 / facade implementations). On V3 it re-sends the BF init packet so the device enforces the new soft-limit; on V2 it updates state for the next tick to clamp against. Reducing a limit also clamps the current strength downward immediately. This unblocks DG-Chat's per-channel safety cap UI in Phase 4b.

## 0.1.1

### Patch Changes

- 39d6853: Fix published `package.json` so `main` / `types` / `exports` point to `dist/`. The previous 0.1.0 tarballs had `main: src/index.ts` from the unsupported `publishConfig.main` override pattern, which broke `import` resolution for downstream consumers. Local dev now requires `npm run build` before `typecheck` / `test` (wired automatically via `pretypecheck` / `pretest`).

## 0.1.0

### Minor Changes

- 85c5805: Initial public release. Carved out from DG-Agent's internal packages and made runtime-agnostic so DG-Agent, DG-MCP, and DG-Chat can share a single source of truth for the device protocol, waveforms, and tool definitions.
