---
'@dg-kit/protocol': minor
'@dg-kit/transport-webbluetooth': patch
'@dg-kit/transport-tauri-blec': patch
---

Add `RequestedDevice` to `@dg-kit/protocol`, and make the two transports'
`RequestedDgLabDevice` / `RequestedDgLabDeviceTauri` aliases of it.

The `{ kind, device, server }` a cross-kind picker returns was declared four
times — once per transport plus once in each app's device layer. Whether the
two transports really are interchangeable then rested on four copies staying
in step by hand, which is exactly the contract a host relies on when it swaps
Web Bluetooth for plugin-blec on Android.

Both existing names stay exported and keep their shape, so this is additive.
