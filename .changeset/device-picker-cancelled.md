---
'@dg-kit/core': minor
'@dg-kit/transport-tauri-blec': patch
---

Add `isDevicePickerCancelled` and `DEVICE_PICKER_CANCELLED_MESSAGE` to
`@dg-kit/core`, and have the Tauri BLE transport throw the shared constant.

Closing the device picker is a normal user action, but both transports report
it by throwing, so consumers have to recognise it. The check and the throw had
drifted: the transport's message is Chinese, and consumers testing only for the
English Web Bluetooth wording surfaced a cancelled picker as an error.
