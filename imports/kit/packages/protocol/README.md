# @dg-kit/protocol

Transport-agnostic BLE protocol adapters for DG-Lab Coyote 2.0 (V2) and Coyote 3.0 (V3).

## What it does

This package implements the **byte-level protocol and tick state machine** for both Coyote generations:

- 100 ms write loop (B0 packets on V3, strength + dual-wave writes on V2)
- Wave playback state machine (loop / one-shot, 25 ms frame grid)
- Strength absolute / relative / clamp logic
- Burst-with-auto-restore
- Emergency stop with stale-notification suppression
- Sequence + ack handling on V3

## What it doesn't do

It doesn't open a BLE connection itself. Pass it characteristic handles via the `BluetoothRemoteGATTCharacteristicLike` interface and it'll drive the device. This way the same protocol code runs in:

- **Browsers** via `@dg-kit/transport-webbluetooth`
- **Node.js** via `@dg-mcp/device-noble` (DG-MCP) or any other BLE backend

## Public API

```ts
import {
  CoyoteProtocolAdapter, // facade: auto-routes V2/V3 by device.name prefix
  CoyoteV2ProtocolAdapter,
  CoyoteV3ProtocolAdapter,
  V2_DEVICE_NAME_PREFIX,
  V3_DEVICE_NAME_PREFIX,
  COYOTE_REQUEST_DEVICE_OPTIONS,
} from '@dg-kit/protocol';
```

Most consumers want `CoyoteProtocolAdapter` — it picks V2 or V3 based on the connecting device's name prefix.
