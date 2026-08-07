# @dg-kit/core

Shared types and contract interfaces for DG-Lab Coyote control libraries.

This package is runtime-agnostic — it has no DOM or Node-only dependencies. It defines the data shapes (`DeviceState`, `DeviceCommand`, `WaveformDefinition`, etc.) and the abstract interfaces (`DeviceClient`, `WaveformLibrary`, `Logger`) that the rest of `@dg-kit/*` and downstream consumers (`DG-Agent`, `DG-MCP`, `DG-Chat`) depend on.

## Install

```bash
npm install @dg-kit/core
```

## Stability

`DeviceCommand`, `DeviceState`, `WaveformDefinition`, and the `DeviceClient` / `WaveformLibrary` interfaces are part of the public contract. Breaking changes to these shapes bump the major version. Internal helpers (e.g. `createEmptyDeviceState`) follow the same versioning policy.
