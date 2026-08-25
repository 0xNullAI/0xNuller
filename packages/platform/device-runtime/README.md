# @0xnullai/device-runtime

Private, SDK-free device runtime shared by product surfaces. It normalizes only vibration, battery,
and RSSI capabilities, keeps backend handles private, fences every output write by session,
topology, safety, and module-lease generations, and exposes one transport-neutral tool provider.

Backends are injected by browser or native shells. Structural backend changes preempt output;
telemetry-only Battery/RSSI refreshes preserve fences. A failed stop latches the executor until a new
backend runtime is created. The runtime does not reconnect devices, restore output, expose raw
commands, or depend on an agent/tool SDK.

The reusable AI adapter is a positive allowlist containing only `device_snapshot`, `device_vibrate`,
`device_stop`, and `device_emergency_stop`. Model schemas never contain `interactionId`; Agent and
Voice inject trusted local tool-call IDs and require exact opaque `deviceId` + `featureId` values.
Scan, disconnect, labels, native identifiers, and Raw operations are not model tools.

`createAiDeviceToolAdapter` is the canonical Agent/Voice binding. It stays lazy during model
composition, reads only an already-open snapshot for instructions, and starts the provider only when
a tool is actually invoked. Tool display names and the output-increasing permission classification
also live here so provider integrations cannot silently expose different AI capabilities.

`DeviceRuntimeModuleBinding` is the canonical human-surface binding. It coalesces startup, binds a
module once, owns one snapshot subscription, and follows an explicitly restarted provider. It never
scans, reconnects, grants permission, or hides command acknowledgements. Use
`createDeviceInteractionId` for bounded human/lifecycle command IDs.

`genericDeviceSafetyPolicy` and `genericDeviceIntensityCap` are the canonical conversion from shared
device-safety settings to normalized generic output. A generic feature has no A/B identity, so the
lower channel cap wins. Non-finite values fail closed, increases/cold starts remain bounded, and the
runtime executor still performs the final clamp immediately before native I/O.

## Consumer ownership matrix

| Consumer            | Shared behavior                                                                                      | Deliberately local behavior                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Web / Android shell | One provider, manager, executor, lease/lifecycle safety controller, settings policy                  | Web Buttplug and Tauri command/event translation                                |
| Control             | Module binding, snapshot stream, scan/disconnect/vibrate/stop actions, settings cap, interaction IDs | Rendering and pointer-release interaction state                                 |
| Agent               | AI adapter, model allowlist/schema/status, display names, permission classification                  | Agent quotas, traces, aborts, and upper consent UI                              |
| Voice               | Same AI adapter, allowlist/schema/status, permission classification                                  | Realtime tool bridge, call consent UI, and hang-up lifecycle                    |
| Video               | Shared provider/executor/sanitized snapshot and exact opaque targets                                 | One-target grant, visual cadence, stale-identity escalation, and run lifecycle  |
| Chat                | Shared DG-Lab session only; generic runtime is intentionally not model/room accessible               | Owner-side room validation and remote-command safety                            |
| Playground          | Shared DG-Lab session and safety settings only                                                       | Game pulse semantics; generic runtime is not an interchangeable waveform target |

Chat and Playground are intentionally absent from the generic runtime permission allowlist. Enabling
them is a new safety/product capability, not a reuse refactor: it requires an explicit target model,
owner-side validation, lease semantics, and stop coverage first.

The package also owns the product-wide attached-device snapshot contracts and their pure mapping to
the shell safety bus. Control, Chat, and Playground share these display snapshots; the mapper does
not issue commands or alter output, leases, limits, or stop behavior.

The DG-Lab product session (`DeviceSession` and `useDevice`) is also canonical here. It owns the
single command queue, per-device Coyote routing, Opossum/sensor adapters, live safety caps, lifecycle
stop guard, and browser/native transport injection seam used by Control, Chat, and Playground.
Feature apps may keep compatibility re-exports, but reusable session code must not live in an app.

## Web embedded backend

`WebEmbeddedButtplugBackend` uses the embedded Web Bluetooth stack `buttplug@4.0.2` with
`buttplug-wasm@3.0.0`; it does not accept an Intiface URL or any WebSocket endpoint. The WASM stack
is loaded only after a secure Web Bluetooth browser passes support checks.

The backend publishes generic device labels and only Vibrate, readable Battery, and readable RSSI
features. Runtime `deviceId` and `featureId` values are opaque and replaced after a device
reappears. Package-native identifiers, feature descriptors, Raw commands, protocol messages, and
branding guesses do not cross the runtime boundary. Because the pinned protocol has no per-device
release command, a requested device disconnect stops output and closes the whole embedded session;
reopening is explicit and receives a fresh runtime session identity.

`WebEmbeddedDeviceRuntimeProvider` is the shell-owned singleton seam for Control, Agent, Voice, and
Video. Its only opt-in UI is under **Settings → About**. The versioned local setting defaults off for
missing, corrupt, or inaccessible storage and is never synchronized remotely. While disabled, the
experimental Control panel is not rendered. Enabling the setting does not start a scan or load the
backend; a user-initiated surface action must start the shared runtime and scan.

`EmbeddedDeviceRuntimeSafetyController` is constructed beside that provider before React render. It
registers one safety session, stops on every shared lease epoch and page/app lifecycle transition,
and reports connected devices without inferring whether physical output is active.

Third-party attribution is in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
