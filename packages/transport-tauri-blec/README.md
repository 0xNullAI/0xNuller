# @dg-kit/transport-tauri-blec

Tauri 2 BLE `DeviceClient` for DG-Lab Coyote, backed by [`@mnlphlp/plugin-blec`](https://github.com/MnlPhlp/tauri-plugin-blec).

Mirror of `@dg-kit/transport-webbluetooth` for non-browser runtimes (Tauri Android primary target; desktop / iOS work as a side-effect of plugin-blec's btleplug backend).

The host application owns the device-picker UI: `TauriBlecDeviceClient` calls back into a `selectDevice` function it receives from the constructor. Web Bluetooth's native chooser does not exist outside the browser.
