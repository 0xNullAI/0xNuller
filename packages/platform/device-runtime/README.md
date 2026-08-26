# @0xnullai/device-runtime

Private, transport-neutral device runtime shared by the product surfaces. Browser and native shells
inject the backend; feature apps consume normalized vibration, battery, and RSSI capabilities without
seeing backend handles or raw commands.

## Safety contract

Every output write is checked against the current runtime session, device topology, safety settings,
permission, and module lease. Structural backend changes stop output and invalidate old targets;
Battery/RSSI refreshes do not. A failed stop locks the executor until the shell creates a new backend
runtime.

The runtime never reconnects a device, restores output, grants permission, or exposes scan, disconnect,
labels, native identifiers, protocol messages, or Raw operations to a model. It also does not depend on
an agent/tool SDK.

Physical instances are never merged by display name. `deviceId` and `featureId` are opaque, short-lived
routing identities, and execution revalidates both immediately before native I/O.

## Choose the integration

- Use `DeviceRuntimeModuleBinding` for human-operated surfaces. It starts the provider at most once,
  binds one module lease, and owns one snapshot subscription. Call `createDeviceInteractionId` for
  bounded human and lifecycle commands.
- Use `createAiDeviceToolAdapter` for Agent or Voice. It is the canonical tool schema, display-name,
  and permission-classification boundary.
- Use `genericDeviceSafetyPolicy` and `genericDeviceIntensityCap` to convert shared safety settings to
  normalized generic output. Generic devices have no A/B channel identity, so the lower channel cap
  wins. Non-finite values fail closed, and increases and cold starts remain bounded; the executor still
  performs the final clamp.

Neither binding scans, reconnects, grants permission, or hides command acknowledgements.

## AI exposure

The AI adapter exposes only `device_snapshot`, `device_vibrate`, `device_stop`, and
`device_emergency_stop`. Tool schemas require exact `deviceId` and `featureId` values and never include
the trusted local `interactionId` injected by Agent or Voice.

Definitions and status are available only when the provider is enabled and the current snapshot has a
connected, healthy vibration feature. Disconnected, faulted, stale, telemetry-only, or previously seen
targets are omitted. The adapter reads an already-open snapshot while composing model instructions and
starts the provider only if a tool is invoked. Agent reevaluates exposure for every request; Voice
replaces instructions and tools together when topology changes.

## Ownership by consumer

| Consumer            | Uses from this package                                               | Remains local                                                          |
| ------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Web / Android shell | Provider, manager, executor, lease/lifecycle safety, settings policy | Web Buttplug and Tauri command/event translation                       |
| Control             | Module binding, snapshots, actions, settings cap, interaction IDs    | Rendering and pointer-release state                                    |
| Agent               | AI adapter, schemas/status, display names, permission classification | Quotas, traces, aborts, and upper consent UI                           |
| Voice               | The same AI adapter and permission classification                    | Realtime bridge, call consent UI, and hang-up lifecycle                |
| Video               | Provider, executor, sanitized snapshots, and exact opaque targets    | One-target grant, visual cadence, stale-target handling, run lifecycle |
| Chat                | Attached-device snapshots and the shared DG-Lab session only         | Room authorization and owner-side remote-command safety                |
| Playground          | Shared DG-Lab session and safety settings only                       | Game pulse semantics                                                   |

Chat and Playground are deliberately excluded from the generic-runtime permission allowlist. Adding
generic targets to either app is a new product capability, not a reuse refactor; it requires an explicit
target model, owner-side validation, lease semantics, and stop coverage.

This package also owns the product-wide attached-device snapshot contract and its pure mapping to the
shell safety bus. Control, Chat, and Playground use those display snapshots; the mapper never issues
commands or changes output, leases, limits, or stop behavior.

The canonical DG-Lab product session (`DeviceSession` and `useDevice`) lives here as well. It owns one
command queue, per-device Coyote routing, Opossum/sensor adapters, live safety caps, the lifecycle stop
guard, and browser/native transport injection used by Control, Chat, and Playground. Apps may keep
compatibility re-exports, but reusable session code belongs in this package.

## Embedded Web Bluetooth backend

`WebEmbeddedButtplugBackend` embeds `buttplug@4.0.2` with `buttplug-wasm@3.0.0`; it accepts neither an
Intiface URL nor a WebSocket endpoint. The WASM stack loads only after a secure browser passes Web
Bluetooth support checks.

Only generic labels and Vibrate, readable Battery, and readable RSSI features cross the runtime
boundary. Runtime IDs are replaced whenever a device reappears. Because the pinned protocol has no
per-device release command, disconnecting one device first stops output and then closes the entire
embedded session. Reopening is explicit and creates a fresh runtime identity.

`WebEmbeddedDeviceRuntimeProvider` is the shell-owned singleton used by Control, Agent, Voice, and
Video. Its versioned opt-in appears only under **Settings -> About**, defaults off when storage is
missing, corrupt, or inaccessible, and is never synchronized. When disabled, generic-device UI,
model context/tools, backend loading, and scanning remain unavailable. Enabling it does not load the
backend or start scanning; only an explicit Control or Video action does that. Video and the legacy
Coyote/Opossum paths remain available in either state.

The shell creates `EmbeddedDeviceRuntimeSafetyController` beside the provider before React renders.
It registers one safety session, stops on every shared lease epoch and page/app lifecycle transition,
and reports connected devices without claiming that physical output is active.

Third-party attribution is in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
