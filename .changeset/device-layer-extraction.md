---
"@dg-kit/core": minor
"@dg-kit/protocol": minor
"@dg-kit/transport-webbluetooth": minor
"@dg-kit/transport-tauri-blec": patch
---

Closed a browser/Tauri asymmetry: `@dg-kit/transport-tauri-blec` already shipped `TauriBlecOpossumClient`/`TauriBlecPawPrintsClient`/`TauriBlecCivetEdgingClient`, but `@dg-kit/transport-webbluetooth` only had a Coyote client — every browser consumer (DG-Agent, DG-Chat) had to hand-roll its own Opossum/sensor client against the bare protocol adapters. This release adds the missing pieces so both transports share one set of contracts:

- `@dg-kit/core` gains `SensorDeviceClient<TReading>` and `DEVICE_KIND_DISPLAY_NAME`.
- `@dg-kit/protocol` gains `OpossumClient`, `OpossumCommandResult`, `PawPrintsClient`, `CivetEdgingClient` (they reference `OpossumState`/`PawPrintsReading`/`CivetPressureReading`, which live here, not in core).
- `@dg-kit/transport-webbluetooth` gains `WebBluetoothOpossumClient`, `WebBluetoothSensorClient` (+ `WebBluetoothPawPrintsClient`/`WebBluetoothCivetEdgingClient`), the `connectAuxDevice`/`attachAuxDevice`/`disconnectAuxDevice` helpers, and the per-kind `*_REQUEST_DEVICE_OPTIONS` scan filters.
- `@dg-kit/transport-tauri-blec`'s `OpossumCommandResult` is now re-exported from `@dg-kit/protocol` instead of being declared a second time (its own export is unchanged, so this is non-breaking).

Also fixes a real bug found while consolidating: `TauriBlecOpossumClient.execute()` hand-rolled its own `OpossumCommand` switch and only handled `vibrateStart`/`vibrateStop`/`vibrateAdjust` — `vibrateSetPattern` and `vibrateBurst` silently resolved as a no-op on Tauri/Android (the browser client was never affected; it already delegated to the adapter). `execute()` now delegates to `OpossumVibrateAdapter.execute()`, the same single source of truth `@dg-kit/protocol` introduced in 1.12.0 for exactly this class of bug.
