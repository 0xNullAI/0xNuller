import type {
  BluetoothDeviceLike,
  BluetoothRemoteGATTLike,
  BluetoothRemoteGATTServerLike,
  BluetoothRemoteGATTServiceLike,
} from '@dg-kit/protocol';
import { PluginBlecCharacteristic } from './characteristic.js';
import type { PluginBlecApi } from './plugin-blec.js';

/**
 * Synthesizes BluetoothDevice/Server/Service shapes from plugin-blec's flat API
 * so protocol adapters (Coyote, and now the sensor/Opossum adapters too)
 * receive the same `(device, server)` context they do in a browser.
 *
 * One shim per device address. The multi-connection fork this package is
 * pinned to (`0xNullAI/tauri-plugin-blec-multi`) can hold several devices
 * connected concurrently, each tracked independently by address — every
 * plugin-blec call this shim's characteristics make is scoped to
 * `args.address` so two shims (e.g. a Coyote and an Opossum) never step on
 * each other. Disconnection is signalled via the `connect()` `onDisconnect`
 * callback, which fires the `gattserverdisconnected` event on `device` to
 * mirror the Web Bluetooth event model.
 */
export function createGattShim(args: {
  address: string;
  name: string;
  api: PluginBlecApi;
  onDisconnect: () => void;
}): {
  device: BluetoothDeviceLike;
  server: BluetoothRemoteGATTServerLike;
  fireDisconnect: () => void;
} {
  const device = new EventTarget() as BluetoothDeviceLike & EventTarget;
  Object.assign(device, { id: args.address, name: args.name });

  const server: BluetoothRemoteGATTServerLike = {
    connected: true,
    async getPrimaryService(serviceUuid: string): Promise<BluetoothRemoteGATTServiceLike> {
      return {
        async getCharacteristic(characteristicUuid: string) {
          return new PluginBlecCharacteristic(
            characteristicUuid,
            args.api,
            serviceUuid,
            args.address,
          );
        },
      };
    },
    // No `requestMTU` here on purpose. `BluetoothRemoteGATTServerLike.requestMTU`
    // is optional and protocol adapters (e.g. CoyoteV3's connect-time handshake)
    // call it as `context.server.requestMTU?.(...)`, so omitting it is a safe,
    // silent no-op — the device falls back to whatever MTU the OS/BLE stack
    // negotiates by default.
    //
    // The fork does add per-device MTU control (`getMtu(address?)` and
    // `setAndroidMtu(mtu)`), but its shape still doesn't map directly onto
    // this hook: `setAndroidMtu` is global (not per-address) and must be
    // called *before* `connect()`, whereas `requestMTU` is invoked
    // post-connect as part of the protocol handshake and is expected to be
    // per-device. Wiring this up for real needs `TauriBlecDeviceClient` (or
    // whichever caller owns the pre-connect sequencing) to call
    // `setAndroidMtu()` ahead of `connect()`, with `requestMTU` here reading
    // back `getMtu(args.address)` rather than actively renegotiating —
    // deferred, same as before, now blocked on multi-device MTU semantics
    // rather than on the dependency bump (which has landed).
  };

  let fireDisconnect: () => void = () => undefined;
  const gatt: BluetoothRemoteGATTLike = {
    connected: true,
    async connect() {
      return server;
    },
    disconnect() {
      // Web Bluetooth's gatt.disconnect() is synchronous in observable effect:
      // the gattserverdisconnected event fires immediately. plugin-blec's
      // disconnect() is async and may not invoke its onDisconnect callback at
      // all on a user-initiated tear-down, so we have to fire the event from
      // here to keep parity with the protocol layer's expectations.
      if (!gatt.connected) return;
      fireDisconnect();
      void args.api.disconnect(args.address).catch(() => undefined);
    },
  };

  Object.defineProperty(device, 'gatt', {
    value: gatt,
    writable: false,
    enumerable: true,
  });

  fireDisconnect = () => {
    if (!gatt.connected && !server.connected) return;
    server.connected = false;
    gatt.connected = false;
    device.dispatchEvent(new Event('gattserverdisconnected'));
    args.onDisconnect();
  };

  return { device, server, fireDisconnect };
}
