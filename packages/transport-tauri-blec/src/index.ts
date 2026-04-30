export {
  type BleDeviceInfo,
  type PluginBlecApi,
  type WriteType,
  __setPluginBlecForTests,
} from './plugin-blec.js';
export { getTauriBlecAvailability, type TauriBlecAvailability } from './availability.js';
export { PluginBlecCharacteristic } from './characteristic.js';
export { createGattShim } from './gatt-shim.js';
export {
  TauriBlecDeviceClient,
  type DeviceSelectionController,
  type DiscoveredDevice,
  type TauriBlecDeviceClientOptions,
} from './client.js';
