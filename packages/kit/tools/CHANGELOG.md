# @dg-kit/tools

## 1.14.0

### Patch Changes

- Updated dependencies [c28b049]
  - @dg-kit/core@1.14.0
  - @dg-kit/waveforms@1.14.0

## 1.13.0

### Patch Changes

- Updated dependencies [249673d]
  - @dg-kit/core@1.13.0
  - @dg-kit/waveforms@1.13.0

## 1.12.0

### Patch Changes

- @dg-kit/core@1.12.0
- @dg-kit/waveforms@1.12.0

## 1.11.0

### Patch Changes

- @dg-kit/core@1.11.0
- @dg-kit/waveforms@1.11.0

## 1.10.0

### Minor Changes

- 0e6657b: Complete the Coyote↔Opossum tool symmetry (5 tools each): new `vibrate_change_pattern`（切换振动节奏）switches a channel's rhythm preset without touching intensity (the vibrate counterpart of `shock_change_wave`), and new `vibrate_burst`（振动脉冲）briefly raises a channel to a target intensity then auto-restores (the counterpart of `shock_burst`).

  `OpossumVibrateAdapter` gains `vibrateBurst(channel, intensity, durationMs)` with the exact semantics of Coyote's `runBurst`: the restore target is `min(current, previous)` so an intervening stop or manual decrease is never pushed back up by a late-firing timer; a second burst on the same channel supersedes the first's restore; `emergencyStop()` and `onDisconnected()` cancel pending restores. `OpossumCommand` gains `vibrateSetPattern` and `vibrateBurst` variants, and `isDeviceToolName` recognizes the two new tool names.

  `vibrate_start` keeps its optional `pattern` parameter for cold starts, but its description now points mid-run rhythm changes at `vibrate_change_pattern`; `shock_change_wave`'s cross-reference likewise now names the dedicated tool instead of the old re-call-vibrate_start workaround.

### Patch Changes

- Updated dependencies [0e6657b]
  - @dg-kit/core@1.10.0
  - @dg-kit/waveforms@1.10.0

## 1.9.0

### Minor Changes

- 5909ca0: Rename the five Coyote tools so their names state the capability (electric stimulation), symmetric with the Opossum `vibrate_*` family: `start`→`shock_start`（启动电击）, `stop`→`shock_stop`（停止电击）, `adjust_strength`→`shock_adjust`（调节电击强度）, `change_wave`→`shock_change_wave`（切换电击波形）, `burst`→`shock_burst`（电击脉冲）. Descriptions now state "仅适用于郊狼设备" and cross-reference the sibling device's tool (`负鼠设备请用 vibrate_*` / `郊狼设备请用 shock_start`), mirroring how the vibrate tools already pointed back.

  Non-breaking: `ToolRegistry` gains alias support (`ToolHandler.aliases`) — the old names still resolve, execute, and rate-limit under the primary name, but `listDefinitions()` only advertises the new names, so LLMs and MCP clients only ever see `shock_*` while older hard-coded callers keep working. `@dg-kit/core`'s `isDeviceToolName` accepts both generations.

### Patch Changes

- Updated dependencies [5909ca0]
  - @dg-kit/core@1.9.0
  - @dg-kit/waveforms@1.9.0

## 1.8.1

### Patch Changes

- @dg-kit/core@1.8.1
- @dg-kit/waveforms@1.8.1

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
  - @dg-kit/waveforms@1.8.0

## 1.7.1

### Patch Changes

- @dg-kit/core@1.7.1
- @dg-kit/waveforms@1.7.1

## 1.7.0

### Patch Changes

- @dg-kit/core@1.7.0
- @dg-kit/waveforms@1.7.0

## 1.6.1

### Patch Changes

- @dg-kit/core@1.6.1
- @dg-kit/waveforms@1.6.1

## 1.6.0

### Patch Changes

- @dg-kit/core@1.6.0
- @dg-kit/waveforms@1.6.0

## 1.5.0

### Patch Changes

- @dg-kit/core@1.5.0
- @dg-kit/waveforms@1.5.0

## 1.4.0

### Minor Changes

- 9f49180: Add `vibrate_start`/`vibrate_stop`/`vibrate_adjust` (Opossum vibrate controller) and `set_indicator_color` (paw-prints/civet-edging/opossum) tools to `createDefaultToolRegistry`. New `OpossumCommand` type and two additive `ToolExecutionPlan` variants (`'opossum'`, `'setIndicatorColor'`) in `@dg-kit/core`. `isDeviceToolName()` now also recognizes the four new tool names. Deliberately does not add `get_sensor_state`/`list_connected_devices` — those need live device-manager state the tools package doesn't have, so they're left as consumer-specific tools (same pattern DG-MCP already uses for `scan`/`connect`/`get_status`).

### Patch Changes

- Updated dependencies [9f49180]
- Updated dependencies [9f49180]
- Updated dependencies [3cc9922]
  - @dg-kit/core@1.4.0
  - @dg-kit/waveforms@1.4.0

## 1.3.0

### Patch Changes

- @dg-kit/core@1.3.0
- @dg-kit/waveforms@1.3.0

## 1.2.1

### Patch Changes

- @dg-kit/core@1.2.1
- @dg-kit/waveforms@1.2.1

## 1.2.0

### Patch Changes

- ea1d12d: Harden `@dg-kit/transport-tauri-blec` for Android shell consumers. Three behaviour fixes; all are additive and require no consumer code changes.
  - **`TauriBlecDeviceClient.disconnect()` now zeroes the device before tearing down BLE.** Mirrors `transport-webbluetooth`'s flow: `protocol.emergencyStop()` runs first so a user-initiated disconnect never leaves Coyote V3 running at its last commanded strength (V3 retains state across drops). Previously a `disconnect()` would just close the GATT link.
  - **GATT-shim `gatt.disconnect()` now fires `gattserverdisconnected` synchronously.** Matches Web Bluetooth observable behaviour. plugin-blec's `disconnect()` is async and not all platforms invoke its `onDisconnect` callback on a user-initiated tear-down, so the shim now fires the event itself and dedupes against a later plugin callback.
  - **Scan result change detection covers name / connection state / services**, not only RSSI. Picker UIs now refresh when devices flip `isConnected` mid-scan or surface late service UUIDs.

  No public API additions; existing test suite extended from 43 to 47 tests.

- Updated dependencies [ea1d12d]
  - @dg-kit/core@1.2.0
  - @dg-kit/waveforms@1.2.0

## 1.1.0

### Minor Changes

- 22de7a5: Add `@dg-kit/transport-tauri-blec` — Tauri 2 BLE `DeviceClient` backed by `@mnlphlp/plugin-blec`. Mirrors `transport-webbluetooth` for non-browser runtimes (Tauri Android primary target). Synthesizes `BluetoothRemoteGATT*Like` shapes from plugin-blec's flat API so the Coyote protocol layer is unchanged.

### Patch Changes

- Updated dependencies [22de7a5]
  - @dg-kit/core@1.1.0
  - @dg-kit/waveforms@1.1.0

## 1.0.1

### Patch Changes

- b189d86: CI / infrastructure release — no API or behaviour changes.
  - Unified PR / issue templates + dependabot config
  - release-guard workflow gates main entry on version bump
  - npm provenance enabled on publish

- Updated dependencies [b189d86]
  - @dg-kit/core@1.0.1
  - @dg-kit/waveforms@1.0.1

## 1.0.0

### Major Changes

- 340e495: First stable release. Three downstream consumers — DG-Agent (browser AI controller), DG-Chat (P2P multi-user room), and DG-MCP (Model Context Protocol server) — have all migrated onto the published `@dg-kit/*` packages and verified end-to-end against real Coyote 2.0 / 3.0 hardware. The public API (DeviceCommand shape, BaseCoyoteProtocolAdapter / WebBluetoothProtocolAdapter interfaces, ToolRegistry, RateLimitPolicy, WaveformLibrary, design-segment primitives, .pulse parser) is now considered stable; breaking changes will only ship as 2.x.

### Patch Changes

- Updated dependencies [340e495]
  - @dg-kit/core@1.0.0
  - @dg-kit/waveforms@1.0.0

## 0.2.0

### Patch Changes

- 55017d6: Add `setLimits(limitA, limitB)` to `BaseCoyoteProtocolAdapter` (and the V2 / V3 / facade implementations). On V3 it re-sends the BF init packet so the device enforces the new soft-limit; on V2 it updates state for the next tick to clamp against. Reducing a limit also clamps the current strength downward immediately. This unblocks DG-Chat's per-channel safety cap UI in Phase 4b.
- Updated dependencies [55017d6]
  - @dg-kit/core@0.2.0
  - @dg-kit/waveforms@0.2.0

## 0.1.1

### Patch Changes

- 39d6853: Fix published `package.json` so `main` / `types` / `exports` point to `dist/`. The previous 0.1.0 tarballs had `main: src/index.ts` from the unsupported `publishConfig.main` override pattern, which broke `import` resolution for downstream consumers. Local dev now requires `npm run build` before `typecheck` / `test` (wired automatically via `pretypecheck` / `pretest`).
- Updated dependencies [39d6853]
  - @dg-kit/core@0.1.1
  - @dg-kit/waveforms@0.1.1

## 0.1.0

### Minor Changes

- 85c5805: Initial public release. Carved out from DG-Agent's internal packages and made runtime-agnostic so DG-Agent, DG-MCP, and DG-Chat can share a single source of truth for the device protocol, waveforms, and tool definitions.

### Patch Changes

- Updated dependencies [85c5805]
  - @dg-kit/core@0.1.0
  - @dg-kit/waveforms@0.1.0
