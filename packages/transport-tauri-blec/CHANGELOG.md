# @dg-kit/transport-tauri-blec

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
