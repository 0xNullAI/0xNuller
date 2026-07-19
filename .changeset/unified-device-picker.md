---
"@dg-kit/transport-webbluetooth": minor
---

Add `requestDgLabDevice()`: opens ONE shared Web Bluetooth chooser scoped to every DG-Lab device kind (Coyote V2/V3, paw-prints, civet-edging, Opossum), connects its GATT server, and identifies which kind was picked via `detectDeviceKind()`. Pairs with the new `WebBluetoothDeviceClient.connectDevice(device, server)` method, which attaches to an already-obtained `(device, server)` pair instead of running its own chooser prompt — a Coyote pick from `requestDgLabDevice()` can now be routed straight into a `WebBluetoothDeviceClient` without a second, Coyote-only chooser prompt.

Lets consumers (DG-Chat, DG-Agent) build a single "连接设备" entry point that auto-detects and connects any of the four device kinds, instead of a separate chooser per kind.
