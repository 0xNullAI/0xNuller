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
 * so the Coyote protocol layer receives the same `(device, server)` context it
 * does in a browser.
 *
 * plugin-blec keeps a single active device internally; we don't track per-device
 * state here. Disconnection is signalled via the `connect()` `onDisconnect`
 * callback, which fires the `gattserverdisconnected` event on `device` to mirror
 * the Web Bluetooth event model.
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
          return new PluginBlecCharacteristic(characteristicUuid, args.api, serviceUuid);
        },
      };
    },
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
      void args.api.disconnect().catch(() => undefined);
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
