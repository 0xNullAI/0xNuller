# @0xnullai/device-runtime

Private, SDK-free device runtime shared by product surfaces. It normalizes only vibration, battery,
and RSSI capabilities, keeps backend handles private, fences every output write by session,
topology, safety, and module-lease generations, and exposes one transport-neutral tool provider.

Backends are injected by browser or native shells. Structural backend changes preempt output;
telemetry-only Battery/RSSI refreshes preserve fences. A failed stop latches the executor until a new
backend runtime is created. The runtime does not reconnect devices, restore output, expose raw
commands, or depend on an agent/tool SDK.

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
Video. Its experimental setting is versioned in local storage, defaults off for missing, corrupt, or
inaccessible storage, and is never synchronized remotely. Enabling the setting does not start a scan
or load the backend; a user-initiated surface action must start the shared runtime and scan.

Third-party attribution is in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
