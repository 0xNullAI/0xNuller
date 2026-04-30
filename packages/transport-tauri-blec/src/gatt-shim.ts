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

  const gatt: BluetoothRemoteGATTLike = {
    connected: true,
    async connect() {
      return server;
    },
    disconnect() {
      void args.api.disconnect().catch(() => undefined);
    },
  };

  Object.defineProperty(device, 'gatt', {
    value: gatt,
    writable: false,
    enumerable: true,
  });

  const fireDisconnect = () => {
    server.connected = false;
    gatt.connected = false;
    device.dispatchEvent(new Event('gattserverdisconnected'));
    args.onDisconnect();
  };

  return { device, server, fireDisconnect };
}
