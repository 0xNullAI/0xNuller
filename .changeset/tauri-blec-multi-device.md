---
"@dg-kit/transport-tauri-blec": minor
---

Add concurrent multi-device connection support to `@dg-kit/transport-tauri-blec`, backed by a fork of `@mnlphlp/plugin-blec` (`0xNullAI/tauri-plugin-blec-multi`) that tracks connections per BLE address instead of assuming a single global connection.

- `PluginBlecApi` (and its `plugin-blec` module mapping) now threads an explicit `address` through every per-device call (`disconnect`, `send`, `read`, `subscribe`, `unsubscribe`, `getMtu`), plus new `connectedDevices()` / `getDeviceConnectionUpdates()` queries.
- `createGattShim()` and `PluginBlecCharacteristic` are scoped per device address, so two shims never step on each other's reads/writes/subscriptions.
- `TauriBlecDeviceClient` (Coyote) always passes its own connected address to plugin-blec instead of relying on the address-less "sole connected device" overload, so multiple instances can stay connected at once.
- New `TauriBlecOpossumClient`, `TauriBlecPawPrintsClient`, and `TauriBlecCivetEdgingClient` — Tauri-backed clients for the three device kinds that previously had no Tauri connection path at all (Web Bluetooth only), mirroring DG-Agent's `device-webbluetooth` Web Bluetooth clients but backed by `connectTauriAuxDevice`/`disconnectTauriAuxDevice` (new `aux-connect.ts`) instead of `navigator.bluetooth.requestDevice()`.
- Shared scan (`scan.ts`) and GATT-ready-retry (`gatt-ready.ts`) helpers factored out of `TauriBlecDeviceClient` so the new clients don't duplicate that logic.

Purely additive — no existing exports changed shape in a breaking way.
