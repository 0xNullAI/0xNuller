---
"@dg-kit/transport-webbluetooth": minor
---

Add opt-in auto-reconnect to `WebBluetoothDeviceClient`. New options on `WebBluetoothDeviceClientOptions`:

- `autoReconnect?: boolean` — when true, a passive `gattserverdisconnected` triggers a silent reconnect using the cached `BluetoothDevice` reference (no chooser prompt).
- `reconnectAttempts?: number` — default 3.
- `reconnectBackoffMs?: number[]` — default `[500, 1500, 4000]`.
- `onReconnectStateChange?: (state: 'reconnecting' | 'reconnected' | 'failed') => void`.

A user-initiated `disconnect()` always wins: any in-flight reconnect (scheduled or actively connecting) is cancelled, and `'reconnected'` is never emitted after manual disconnect. New `ReconnectState` type is exported.
