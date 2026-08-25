# @0xnullai/device-runtime

Private, SDK-free device runtime shared by product surfaces. It normalizes only vibration, battery,
and RSSI capabilities, keeps backend handles private, fences every output write by session,
topology, safety, and module-lease generations, and exposes one transport-neutral tool provider.

Backends are injected by browser or native shells. Structural backend changes preempt output; telemetry-only Battery/RSSI refreshes preserve fences. A failed stop latches the executor until a new backend runtime is created. The runtime does not reconnect devices, restore output, expose raw commands, or depend on an agent/tool SDK.
