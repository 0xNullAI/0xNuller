# @dg-kit/transport-tauri-blec

## 1.14.0

### Minor Changes

- 9720997: Expose `deviceId` on both transport clients, and stop the Web Bluetooth client
  from silently evicting a connected device.

  Both clients are scoped to one device, so holding several means holding several
  clients. Two things were missing for that to be usable:

  `deviceId` gives each client a stable identity for the device it holds —
  `BluetoothDevice.id` on web, the BLE address on Tauri, both stable across a
  drop-and-reconnect. A caller holding several devices can now key them the same
  way on both platforms instead of branching on the transport. It is the same
  value `TauriBlecDeviceClient.address` already returned, under the shared name.

  `WebBluetoothDeviceClient.connectDevice()` now throws `设备已连接` when it
  already holds a _different, still connected_ device, matching the guard
  `TauriBlecDeviceClient` has always had. It previously dropped the previous
  device's GATT link instead — and because `protocol.onConnected()` has by then
  rebound the adapter (and with it `emergencyStop()`) to the new device, there
  was no longer any way to reach the evicted one to zero it. On a V3 Coyote,
  which retains its state across a BLE drop, that left a device outputting at its
  last commanded strength, on a body, unreachable even by the global stop button.

  Re-attaching the device already held, or replacing one whose link has already
  dropped, still works: that is the reconnect path, and it is the only case where
  the previous device cannot be left running.

### Patch Changes

- c28b049: Add `isDevicePickerCancelled` and `DEVICE_PICKER_CANCELLED_MESSAGE` to
  `@dg-kit/core`, and have the Tauri BLE transport throw the shared constant.

  Closing the device picker is a normal user action, but both transports report
  it by throwing, so consumers have to recognise it. The check and the throw had
  drifted: the transport's message is Chinese, and consumers testing only for the
  English Web Bluetooth wording surfaced a cancelled picker as an error.

- fff5af8: Add `RequestedDevice` to `@dg-kit/protocol`, and make the two transports'
  `RequestedDgLabDevice` / `RequestedDgLabDeviceTauri` aliases of it.

  The `{ kind, device, server }` a cross-kind picker returns was declared four
  times — once per transport plus once in each app's device layer. Whether the
  two transports really are interchangeable then rested on four copies staying
  in step by hand, which is exactly the contract a host relies on when it swaps
  Web Bluetooth for plugin-blec on Android.

  Both existing names stay exported and keep their shape, so this is additive.

- Updated dependencies [c28b049]
- Updated dependencies [fff5af8]
  - @dg-kit/core@1.14.0
  - @dg-kit/protocol@1.14.0

## 1.13.0

### Patch Changes

- 249673d: Closed a browser/Tauri asymmetry: `@dg-kit/transport-tauri-blec` already shipped `TauriBlecOpossumClient`/`TauriBlecPawPrintsClient`/`TauriBlecCivetEdgingClient`, but `@dg-kit/transport-webbluetooth` only had a Coyote client — every browser consumer (DG-Agent, DG-Chat) had to hand-roll its own Opossum/sensor client against the bare protocol adapters. This release adds the missing pieces so both transports share one set of contracts:
  - `@dg-kit/core` gains `SensorDeviceClient<TReading>` and `DEVICE_KIND_DISPLAY_NAME`.
  - `@dg-kit/protocol` gains `OpossumClient`, `OpossumCommandResult`, `PawPrintsClient`, `CivetEdgingClient` (they reference `OpossumState`/`PawPrintsReading`/`CivetPressureReading`, which live here, not in core).
  - `@dg-kit/transport-webbluetooth` gains `WebBluetoothOpossumClient`, `WebBluetoothSensorClient` (+ `WebBluetoothPawPrintsClient`/`WebBluetoothCivetEdgingClient`), the `connectAuxDevice`/`attachAuxDevice`/`disconnectAuxDevice` helpers, and the per-kind `*_REQUEST_DEVICE_OPTIONS` scan filters.
  - `@dg-kit/transport-tauri-blec`'s `OpossumCommandResult` is now re-exported from `@dg-kit/protocol` instead of being declared a second time (its own export is unchanged, so this is non-breaking).

  Also fixes a real bug found while consolidating: `TauriBlecOpossumClient.execute()` hand-rolled its own `OpossumCommand` switch and only handled `vibrateStart`/`vibrateStop`/`vibrateAdjust` — `vibrateSetPattern` and `vibrateBurst` silently resolved as a no-op on Tauri/Android (the browser client was never affected; it already delegated to the adapter). `execute()` now delegates to `OpossumVibrateAdapter.execute()`, the same single source of truth `@dg-kit/protocol` introduced in 1.12.0 for exactly this class of bug.

- Updated dependencies [249673d]
  - @dg-kit/core@1.13.0
  - @dg-kit/protocol@1.13.0

## 1.12.0

### Patch Changes

- Updated dependencies [88b2d46]
  - @dg-kit/protocol@1.12.0
  - @dg-kit/core@1.12.0

## 1.11.0

### Patch Changes

- Updated dependencies [f341ecc]
  - @dg-kit/protocol@1.11.0
  - @dg-kit/core@1.11.0

## 1.10.0

### Patch Changes

- Updated dependencies [0e6657b]
  - @dg-kit/core@1.10.0
  - @dg-kit/protocol@1.10.0

## 1.9.0

### Patch Changes

- Updated dependencies [5909ca0]
  - @dg-kit/core@1.9.0
  - @dg-kit/protocol@1.9.0

## 1.8.1

### Patch Changes

- Updated dependencies [f85b923]
  - @dg-kit/protocol@1.8.1
  - @dg-kit/core@1.8.1

## 1.8.0

### Patch Changes

- Updated dependencies [500648d]
  - @dg-kit/core@1.8.0
  - @dg-kit/protocol@1.8.0

## 1.7.1

### Patch Changes

- c1a9719: Fix a real "当前环境不支持连接郊狼设备" / `NotFoundError: No Services matching UUID ... found in Device` failure on first-time Web Bluetooth pairing: `WebBluetoothDeviceClient.connectDevice()` called `getPrimaryService()` immediately after `gatt.connect()` resolved, with no retry — but Chrome's Web Bluetooth can resolve `gatt.connect()` before its internal GATT service cache is guaranteed populated, especially on a fresh pairing.

  `@dg-kit/transport-tauri-blec` already had a `runWithGattReadyRetry` helper for the identical race on Android (plugin-blec's `connect()` has the same "resolves before service discovery" gap). That retry logic moves to `@dg-kit/protocol` (transport-agnostic — it only wraps a `() => Promise<void>` attempt with a delay+retry loop matching known transient-error message patterns) and is now also applied to `WebBluetoothDeviceClient.connectDevice()`. `@dg-kit/transport-tauri-blec`'s own `gatt-ready.ts` becomes a re-export for backward compatibility.

  New `WebBluetoothDeviceClientOptions.gattReadyRetryOptions` lets callers tune the retry (mainly for tests); defaults match the Tauri side (300ms initial delay, 3s total retry budget, 250ms interval).

- Updated dependencies [c1a9719]
  - @dg-kit/protocol@1.7.1
  - @dg-kit/core@1.7.1

## 1.7.0

### Minor Changes

- 058b1ee: Add `requestDgLabDeviceTauri()`: a single unified cross-kind scan+picker for Tauri Android, mirroring `@dg-kit/transport-webbluetooth`'s `requestDgLabDevice()`. Runs ONE plugin-blec scan across every DG-Lab device kind's name prefix (`DG_LAB_TAURI_NAME_PREFIXES`), presents ONE host-supplied picker, auto-detects the picked device's kind via `detectDeviceKind()`, connects it, and returns `{ kind, device, server }` for the caller to route.

  Add a matching `connectDevice(device, server)` passthrough to all 4 client kinds — `TauriBlecDeviceClient` (Coyote), `TauriBlecOpossumClient`, and the shared `TauriBlecSensorClient` base used by `TauriBlecPawPrintsClient`/`TauriBlecCivetEdgingClient` — so a picked device from `requestDgLabDeviceTauri()` can attach directly to the right client without a second, kind-scoped scan+picker. `aux-connect.ts` also now exports `attachTauriAuxDevice()`, the reusable "attach an already-connected pair" half of `connectTauriAuxDevice()`.

  This closes the gap that previously forced downstream apps (DG-Agent, DG-Chat) into an interim "pick a kind first, then scan" flow on Tauri Android — they can now offer the same one-button, auto-detected connect experience Web Bluetooth already has.

### Patch Changes

- @dg-kit/core@1.7.0
- @dg-kit/protocol@1.7.0

## 1.6.1

### Patch Changes

- Updated dependencies [fad835c]
  - @dg-kit/protocol@1.6.1
  - @dg-kit/core@1.6.1

## 1.6.0

### Minor Changes

- f51c733: Add concurrent multi-device connection support to `@dg-kit/transport-tauri-blec`, backed by a fork of `@mnlphlp/plugin-blec` (`0xNullAI/tauri-plugin-blec-multi`) that tracks connections per BLE address instead of assuming a single global connection.
  - `PluginBlecApi` (and its `plugin-blec` module mapping) now threads an explicit `address` through every per-device call (`disconnect`, `send`, `read`, `subscribe`, `unsubscribe`, `getMtu`), plus new `connectedDevices()` / `getDeviceConnectionUpdates()` queries.
  - `createGattShim()` and `PluginBlecCharacteristic` are scoped per device address, so two shims never step on each other's reads/writes/subscriptions.
  - `TauriBlecDeviceClient` (Coyote) always passes its own connected address to plugin-blec instead of relying on the address-less "sole connected device" overload, so multiple instances can stay connected at once.
  - New `TauriBlecOpossumClient`, `TauriBlecPawPrintsClient`, and `TauriBlecCivetEdgingClient` — Tauri-backed clients for the three device kinds that previously had no Tauri connection path at all (Web Bluetooth only), mirroring DG-Agent's `device-webbluetooth` Web Bluetooth clients but backed by `connectTauriAuxDevice`/`disconnectTauriAuxDevice` (new `aux-connect.ts`) instead of `navigator.bluetooth.requestDevice()`.
  - Shared scan (`scan.ts`) and GATT-ready-retry (`gatt-ready.ts`) helpers factored out of `TauriBlecDeviceClient` so the new clients don't duplicate that logic.

  Purely additive — no existing exports changed shape in a breaking way.

### Patch Changes

- @dg-kit/core@1.6.0
- @dg-kit/protocol@1.6.0

## 1.5.0

### Patch Changes

- @dg-kit/core@1.5.0
- @dg-kit/protocol@1.5.0

## 1.4.0

### Minor Changes

- 9f49180: Add opt-in auto-reconnect to `TauriBlecDeviceClient`, mirroring `transport-webbluetooth` 1.3.0. New options on `TauriBlecDeviceClientOptions`: `autoReconnect?: boolean` (default false — when true, an unexpected disconnect signalled by plugin-blec triggers a silent reconnect to the last-connected device address, skipping the scan/selectDevice picker), `reconnectAttempts?: number` (default 3), `reconnectBackoffMs?: number[]` (default `[500, 1500, 4000]`), and `onReconnectStateChange?: (state: 'reconnecting' | 'reconnected' | 'failed') => void`. A user-initiated `disconnect()` always cancels any pending or in-flight reconnect and is never followed by one. Reconnect attempts reuse the existing GATT-ready retry logic and the manual-connect reentrancy guard, so they can't race a concurrent `connect()` call. New `ReconnectState` type is exported.

  Also investigated MTU negotiation to support `@dg-kit/protocol`'s new optional `BluetoothRemoteGATTServerLike.requestMTU` hook (used by the Coyote V3 connect-time handshake). The pinned `@mnlphlp/plugin-blec@^0.8.0` exposes no MTU control API at all, so `requestMTU` is intentionally left unimplemented on this package's GATT shim rather than faked — protocol adapters optional-chain on it, so omitting it is a safe no-op and the transport falls back to whatever MTU the OS negotiates by default. `gatt-shim.ts` documents this along with what a real implementation would need (plugin-blec 0.12.0's `setAndroidMtu`/`getMtu`, which would also require restructuring since `setAndroidMtu` must be called pre-connect rather than during the post-connect handshake this hook is invoked from).

### Patch Changes

- 3cc9922: Multi-agent code review of the paw-prints/civet-edging/opossum/handshake work found and fixed several real bugs before publish:
  - **The three new device adapters never ran the connect-time handshake** PR #3 added for Coyote V3 — since they share the exact same 47L12x GATT skeleton, this reproduced the same "device won't respond" symptom for newer firmware on paw-prints/civet-edging/opossum too. Extracted the handshake (and the write-fallback-chain helper, previously copy-pasted four times) into a shared `gatt-utils.ts` module all four adapters now use.
  - **`CoyoteProtocolAdapter` (the facade) silently routed non-Coyote devices to the V3 adapter** — a scanned paw-prints/civet-edging/opossum device fed through the facade would get Coyote-shaped B0/BF writes. Now throws a clear error via `detectDeviceKind()` instead of misrouting.
  - **`transport-webbluetooth`'s default scan filter** still only listed Coyote name prefixes, so civet-edging/opossum devices wouldn't appear in the Web Bluetooth chooser unless a caller explicitly passed `DG_LAB_REQUEST_DEVICE_OPTIONS`. Now defaults to the broader filter.
  - **`transport-tauri-blec`'s `forceTeardown()` (disconnect racing an in-flight reconnect) skipped the emergency-stop-before-disconnect safety step** that a normal `disconnect()` does — a user disconnecting mid-reconnect could leave the device running at its last commanded strength with no way to remotely stop it.
  - Civet-edging's `set_indicator_color` tool support had no way to change the LED color without forcing the pressure stream on or off as a side effect (there's no separate color-only opcode) — added `setIndicatorColor()`, which preserves the current streaming state.
  - Opossum's connect-failure cleanup path left a live GATT notification subscription dangling if a step after `startNotifications()` threw. Added `adjustIntensity()` so `vibrate_adjust`-style callers get an atomic read-modify-write instead of composing `getState()` + `setIntensity()` themselves (avoids a lost-update race between two concurrent adjusts).

- Updated dependencies [9f49180]
- Updated dependencies [d14a78a]
- Updated dependencies [9f49180]
- Updated dependencies [3cc9922]
- Updated dependencies [4af7814]
  - @dg-kit/core@1.4.0
  - @dg-kit/protocol@1.4.0

## 1.3.0

### Patch Changes

- @dg-kit/core@1.3.0
- @dg-kit/protocol@1.3.0

## 1.2.1

### Patch Changes

- f02efa8: fix(transport-tauri-blec): ride out Android's async GATT discovery race + reject double-tap connect

  `@mnlphlp/plugin-blec`'s `connect()` resolves before Android's
  `BluetoothGatt.discoverServices` is guaranteed visible. The first
  `send` / `subscribe` inside `protocol.onConnected()` (which runs
  right after `connect()` resolves) then fails with
  `No services matching UUID`. This was reproducible on the v1.0.0
  (DG-Chat) and v4.0.0 (DG-Agent) Android shells, especially on
  Android 14/15 BLE stacks.

  `TauriBlecDeviceClient.connect()` now waits `gattReadyInitialDelayMs`
  (default 300 ms) after plugin-blec returns, then retries
  `protocol.onConnected()` with exponential cadence
  (`gattReadyIntervalMs`, default 250 ms) until either the call succeeds
  or `gattReadyTimeoutMs` (default 3000 ms) elapses. Only errors whose
  message matches a known GATT-not-ready pattern are retried; other
  errors propagate immediately. `protocol.onConnected()` already
  resets its own state on failure, so retrying it is safe.

  All four knobs are overridable via `TauriBlecDeviceClientOptions`
  (`gattReadyInitialDelayMs`, `gattReadyTimeoutMs`,
  `gattReadyIntervalMs`, `gattReadyErrorPatterns`). Existing callers
  see no API change.

  Additionally: `TauriBlecDeviceClient.connect()` now rejects with a
  clear error when called concurrently or after a successful connect.
  A double-tap on the connect button previously started two parallel
  scans / two `plugin-blec.connect()` calls, leaving plugin-blec's
  single active peripheral state and the protocol layer in undefined
  shape.
  - @dg-kit/core@1.2.1
  - @dg-kit/protocol@1.2.1

## 1.2.0

### Minor Changes

- ea1d12d: Harden `@dg-kit/transport-tauri-blec` for Android shell consumers. Three behaviour fixes; all are additive and require no consumer code changes.
  - **`TauriBlecDeviceClient.disconnect()` now zeroes the device before tearing down BLE.** Mirrors `transport-webbluetooth`'s flow: `protocol.emergencyStop()` runs first so a user-initiated disconnect never leaves Coyote V3 running at its last commanded strength (V3 retains state across drops). Previously a `disconnect()` would just close the GATT link.
  - **GATT-shim `gatt.disconnect()` now fires `gattserverdisconnected` synchronously.** Matches Web Bluetooth observable behaviour. plugin-blec's `disconnect()` is async and not all platforms invoke its `onDisconnect` callback on a user-initiated tear-down, so the shim now fires the event itself and dedupes against a later plugin callback.
  - **Scan result change detection covers name / connection state / services**, not only RSSI. Picker UIs now refresh when devices flip `isConnected` mid-scan or surface late service UUIDs.

  No public API additions; existing test suite extended from 43 to 47 tests.

### Patch Changes

- Updated dependencies [ea1d12d]
  - @dg-kit/core@1.2.0
  - @dg-kit/protocol@1.2.0

## 1.1.0

### Minor Changes

- 22de7a5: Add `@dg-kit/transport-tauri-blec` — Tauri 2 BLE `DeviceClient` backed by `@mnlphlp/plugin-blec`. Mirrors `transport-webbluetooth` for non-browser runtimes (Tauri Android primary target). Synthesizes `BluetoothRemoteGATT*Like` shapes from plugin-blec's flat API so the Coyote protocol layer is unchanged.

### Patch Changes

- Updated dependencies [22de7a5]
  - @dg-kit/core@1.1.0
  - @dg-kit/protocol@1.1.0
