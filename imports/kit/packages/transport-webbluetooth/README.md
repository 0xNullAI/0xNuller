# @dg-kit/transport-webbluetooth

Browser-side `DeviceClient` for DG-Lab Coyote, built on Web Bluetooth.

This package is the glue between the browser's `navigator.bluetooth.requestDevice()` chooser and `@dg-kit/protocol`. The protocol code itself is environment-agnostic; this package provides the GATT connection layer that drives it.

## Usage

```ts
import { CoyoteProtocolAdapter } from '@dg-kit/protocol';
import {
  WebBluetoothDeviceClient,
  getWebBluetoothAvailability,
} from '@dg-kit/transport-webbluetooth';

const availability = getWebBluetoothAvailability();
if (!availability.supported) {
  throw new Error(availability.reason);
}

const protocol = new CoyoteProtocolAdapter();
const device = new WebBluetoothDeviceClient({ protocol });
await device.connect(); // pops the browser chooser
```

`CoyoteProtocolAdapter` auto-detects V2 vs V3 from the connecting device's name prefix.

## Requirements

- Browser: Chrome/Edge with Web Bluetooth (HTTPS or localhost).
- Mobile: Bluefy (iOS) / Chrome (Android).
