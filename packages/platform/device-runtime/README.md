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
device safety settings.
