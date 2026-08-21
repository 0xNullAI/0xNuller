---
'@dg-kit/protocol': patch
'@dg-kit/transport-webbluetooth': patch
---

Read DG-Lab battery levels from the standard BLE Battery Service and preserve an unavailable reading instead of reporting a false 0%.

Recover from Chromium's `GATT Server is disconnected` service-discovery race by reconnecting before retrying the protocol handshake.
