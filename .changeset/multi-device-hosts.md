---
'@dg-kit/transport-webbluetooth': minor
'@dg-kit/transport-tauri-blec': minor
---

Expose `deviceId` on both transport clients, and stop the Web Bluetooth client
from silently evicting a connected device.

Both clients are scoped to one device, so holding several means holding several
clients. Two things were missing for that to be usable:

`deviceId` gives each client a stable identity for the device it holds —
`BluetoothDevice.id` on web, the BLE address on Tauri, both stable across a
drop-and-reconnect. A caller holding several devices can now key them the same
way on both platforms instead of branching on the transport. It is the same
value `TauriBlecDeviceClient.address` already returned, under the shared name.

`WebBluetoothDeviceClient.connectDevice()` now throws `设备已连接` when it
already holds a *different, still connected* device, matching the guard
`TauriBlecDeviceClient` has always had. It previously dropped the previous
device's GATT link instead — and because `protocol.onConnected()` has by then
rebound the adapter (and with it `emergencyStop()`) to the new device, there
was no longer any way to reach the evicted one to zero it. On a V3 Coyote,
which retains its state across a BLE drop, that left a device outputting at its
last commanded strength, on a body, unreachable even by the global stop button.

Re-attaching the device already held, or replacing one whose link has already
dropped, still works: that is the reconnect path, and it is the only case where
the previous device cannot be left running.
