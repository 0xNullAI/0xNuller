---
"@dg-kit/protocol": patch
"@dg-kit/transport-webbluetooth": patch
"@dg-kit/transport-tauri-blec": patch
---

Fix a real "当前环境不支持连接郊狼设备" / `NotFoundError: No Services matching UUID ... found in Device` failure on first-time Web Bluetooth pairing: `WebBluetoothDeviceClient.connectDevice()` called `getPrimaryService()` immediately after `gatt.connect()` resolved, with no retry — but Chrome's Web Bluetooth can resolve `gatt.connect()` before its internal GATT service cache is guaranteed populated, especially on a fresh pairing.

`@dg-kit/transport-tauri-blec` already had a `runWithGattReadyRetry` helper for the identical race on Android (plugin-blec's `connect()` has the same "resolves before service discovery" gap). That retry logic moves to `@dg-kit/protocol` (transport-agnostic — it only wraps a `() => Promise<void>` attempt with a delay+retry loop matching known transient-error message patterns) and is now also applied to `WebBluetoothDeviceClient.connectDevice()`. `@dg-kit/transport-tauri-blec`'s own `gatt-ready.ts` becomes a re-export for backward compatibility.

New `WebBluetoothDeviceClientOptions.gattReadyRetryOptions` lets callers tune the retry (mainly for tests); defaults match the Tauri side (300ms initial delay, 3s total retry budget, 250ms interval).
