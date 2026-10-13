---
'@dg-kit/protocol': minor
'@dg-kit/transport-tauri-blec': minor
---

- Coyote and Opossum `emergencyStop()` retry a failed stop write once and then reject (`急停指令未能送达设备`) instead of reporting a stop that never reached the device.
- Coyote V3 no longer blocks every later strength change after a lost B1 acknowledgement; the unanswered change is not resent.
- Protocol adapters expose `nativeStopRecipe()`: the service, characteristic and bytes that zero the device, for a native layer that must stop it without the page.
- `@dg-kit/transport-tauri-blec` registers that recipe with plugin-blec after connecting (with a 1.5 s write watchdog) and tries the plugin's preemptive stop first on `emergencyStop()`. `armNativeStop` and `nativeStop` are exported. Plugins without these commands are tolerated.
