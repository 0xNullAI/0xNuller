# @dg-kit/transport-tauri-blec

Tauri 2 BLE clients for the DG-Lab device family, backed by a multi-device fork of [`@mnlphlp/plugin-blec`](https://github.com/MnlPhlp/tauri-plugin-blec).

Mirror of `@dg-kit/transport-webbluetooth` for non-browser runtimes (Tauri Android primary target; desktop / iOS work as a side-effect of plugin-blec's btleplug backend).

The host application owns the device-picker UI: every client in this package calls back into a `selectDevice` function it receives from the constructor. Web Bluetooth's native chooser does not exist outside the browser.

## Native scanner coordination

Every plugin-blec scan claims the host's `dg_blec_claim_scanner` command before starting and calls `dg_blec_release_scanner` only after scan stop and post-scan cleanup succeed. The Android host registers these commands in default and experimental builds so plugin-blec and the embedded Buttplug backend cannot scan concurrently. Stop failures deliberately retain the native lease. Hosts embedding this transport must provide the same claim/release command contract.

## Multiple concurrent connections

Upstream `@mnlphlp/plugin-blec` only tracks one connected device at a time. This package is pinned to [`0xNullAI/tauri-plugin-blec-multi`](https://github.com/0xNullAI/tauri-plugin-blec-multi), a fork that lets several devices stay connected concurrently (each call scoped by BLE address), so a Coyote host and an auxiliary device (Opossum vibrate controller, paw-prints, civet-edging) can be connected at the same time from the same app.

**Dependency wiring**: `package.json` points `@mnlphlp/plugin-blec` at the fork via a git URL (`git+https://github.com/0xNullAI/tauri-plugin-blec-multi.git#main`) rather than a version on the npm registry. This is an interim measure — the fork hasn't been published under its own npm name yet. It keeps the import path (`@mnlphlp/plugin-blec`) and every downstream `import` statement in this package unchanged, at the cost of npm installs depending on GitHub being reachable and the fork's `prepare` script (`rollup -c`) running on install (its build output isn't committed). Once the fork is published under a scoped name (e.g. `@0xnullai/tauri-plugin-blec-multi`) or upstreamed, swap this one line back to a registry version — no other code in this package needs to change, since everything talks to the `PluginBlecApi` shim in `plugin-blec.ts`, not the raw module.

**Clients in this package**, one per device kind, each independently connectable/disconnectable by BLE address:

- `TauriBlecDeviceClient` — Coyote (V2/V3), implements `@dg-kit/core`'s `DeviceClient`.
- `TauriBlecOpossumClient` — Opossum vibrate controller, wraps `@dg-kit/protocol`'s `OpossumVibrateAdapter`.
- `TauriBlecPawPrintsClient` / `TauriBlecCivetEdgingClient` (both `TauriBlecSensorClient<TReading>` instances) — paw-prints / civet-edging sensors, wrap `PawPrintsSensorAdapter` / `CivetPressureSensorAdapter`.

The Opossum/sensor clients are built on `connectTauriAuxDevice`/`disconnectTauriAuxDevice` (`aux-connect.ts`), the Tauri equivalent of DG-Agent's `device-webbluetooth` package's `connectAuxDevice`/`disconnectAuxDevice` helpers for Web Bluetooth — same connect-before-replacing-the-previous-device ordering, same `gattserverdisconnected`-event wiring (synthesized here by `createGattShim`, one shim per device address), just backed by a scan+picker+`plugin-blec.connect()` flow instead of `navigator.bluetooth.requestDevice()`.
