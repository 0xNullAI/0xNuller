# @0xnullai/device-runtime

Private DG-Lab device layer shared by the product surfaces: the canonical session, the shared
connection registry, attached-device snapshots, and the output-target selection model. Only DG-Lab
devices (Coyote, Opossum, and DG sensors) are supported.

## Ownership by consumer

| Consumer            | Uses from this package                                         | Remains local                                                     |
| ------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| Web / Android shell | `DgLabConnectionRegistry`, transport injection, safety session | Web Bluetooth and Tauri transport translation                     |
| Control             | Shared DG-Lab session, attached-device snapshots               | Rendering and pointer-release state                               |
| Agent / Voice       | Registry clients for Coyote, Opossum, and sensors              | Tool schemas, quotas, traces, aborts, and consent UI              |
| Video               | Registry clients and the unified Coyote/Opossum target model   | One-target grant, visual cadence, stale-target handling, run loop |
| Chat                | Attached-device snapshots and the shared DG-Lab session only   | Room authorization and owner-side remote-command safety           |
| Playground          | Shared DG-Lab session and safety settings only                 | Game pulse semantics                                              |

This package also owns the product-wide attached-device snapshot contract and its pure mapping to the
shell safety bus. Control, Chat, and Playground use those display snapshots; the mapper never issues
commands or changes output, leases, limits, or stop behavior.

The canonical DG-Lab product session (`DeviceSession` and `useDevice`) lives here as well. It owns one
command queue, per-device Coyote routing, Opossum/sensor adapters, live safety caps, the lifecycle stop
guard, and browser/native transport injection used by Control, Chat, and Playground. Apps may keep
compatibility re-exports, but reusable session code belongs in this package.

`createUnifiedOutputTargets` projects connected Coyotes and Opossums into one selection model. Every
physical instance keeps an opaque identity even when names match, and caps come only from the shared
device safety settings and the device's own limits.

## Per-device limits

Each Coyote and Opossum may have its own A/B limit on top of the global per-type caps. The registry
applies `min(global, own)` at every write (read at write time, so queued work sees a lowered cap),
stops a device whose running output is above a lowered cap (global or own), and refuses a waveform
or burst on a channel still above its cap. A Coyote snapshot's `state.limitA/limitB` and every
output snapshot's `limits` already include it, so modules, the shell bar and model context show the
enforced number (model context does for Coyotes; it still names the global Opossum caps). The hardware soft limit (V3 BF packet) is not written: the holder clamp is the
single enforcement point.

Limits are remembered by `stableKey` (`deriveDgLabStableKey`), a hash of the transport's stable
device id (Web Bluetooth `device.id`, Android BLE address), falling back to the advertised name.
The settings page uses `registry.listDeviceLimits()`, `subscribeDeviceLimits()`,
`setOwnLimits(idOrStableKey, { a?, b? })`, `forgetDeviceLimits(stableKey)` or the
`useDgLabDeviceLimits(registry)` hook; none needs a lease. `useDevice().setLimit` edits the same
per-device value.
