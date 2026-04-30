---
'@dg-kit/transport-tauri-blec': minor
'@dg-kit/core': minor
'@dg-kit/protocol': minor
'@dg-kit/waveforms': minor
'@dg-kit/tools': minor
'@dg-kit/transport-webbluetooth': minor
---

Add `@dg-kit/transport-tauri-blec` — Tauri 2 BLE `DeviceClient` backed by `@mnlphlp/plugin-blec`. Mirrors `transport-webbluetooth` for non-browser runtimes (Tauri Android primary target). Synthesizes `BluetoothRemoteGATT*Like` shapes from plugin-blec's flat API so the Coyote protocol layer is unchanged.
