---
"@dg-kit/core": minor
"@dg-kit/protocol": minor
---

Add `DeviceKind`, `SensorState`, and `detectDeviceKind()` — the shared foundation for supporting the other 47L12x-family devices (paw-prints sensor, civet-edging sensor, opossum vibrate controller) alongside Coyote. Also adds `WebBluetoothSensorAdapter<TReading>`, a narrower adapter contract for event/telemetry-pushing sensor devices, and `DG_LAB_REQUEST_DEVICE_OPTIONS`, a scan filter covering all known device prefixes. All additive — existing Coyote-only `DeviceState`/`DeviceCommand`/`CoyoteProtocolAdapter` are unchanged.
