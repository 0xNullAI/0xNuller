---
"@dg-kit/transport-tauri-blec": minor
---

Add `requestDgLabDeviceTauri()`: a single unified cross-kind scan+picker for Tauri Android, mirroring `@dg-kit/transport-webbluetooth`'s `requestDgLabDevice()`. Runs ONE plugin-blec scan across every DG-Lab device kind's name prefix (`DG_LAB_TAURI_NAME_PREFIXES`), presents ONE host-supplied picker, auto-detects the picked device's kind via `detectDeviceKind()`, connects it, and returns `{ kind, device, server }` for the caller to route.

Add a matching `connectDevice(device, server)` passthrough to all 4 client kinds — `TauriBlecDeviceClient` (Coyote), `TauriBlecOpossumClient`, and the shared `TauriBlecSensorClient` base used by `TauriBlecPawPrintsClient`/`TauriBlecCivetEdgingClient` — so a picked device from `requestDgLabDeviceTauri()` can attach directly to the right client without a second, kind-scoped scan+picker. `aux-connect.ts` also now exports `attachTauriAuxDevice()`, the reusable "attach an already-connected pair" half of `connectTauriAuxDevice()`.

This closes the gap that previously forced downstream apps (DG-Agent, DG-Chat) into an interim "pick a kind first, then scan" flow on Tauri Android — they can now offer the same one-button, auto-detected connect experience Web Bluetooth already has.
