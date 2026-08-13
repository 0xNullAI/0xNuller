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
  prewarmDeviceScan,
  scanAndSelectDevice,
  __resetPrewarmScanForTests,
  type DeviceSelectionController,
  type DiscoveredDevice,
  type ScanAndSelectOptions,
} from './scan.js';
export { runWithGattReadyRetry, type GattReadyRetryOptions } from './gatt-ready.js';
export {
  TauriBlecDeviceClient,
  type ReconnectState,
  type TauriBlecDeviceClientOptions,
} from './client.js';
export {
  attachTauriAuxDevice,
  connectTauriAuxDevice,
  disconnectTauriAuxDevice,
  type ConnectableAdapter,
  type TauriAuxDeviceConnectOptions,
} from './aux-connect.js';
export {
  prewarmDgLabDeviceScan,
  requestDgLabDeviceTauri,
  DG_LAB_TAURI_NAME_PREFIXES,
  type RequestDgLabDeviceTauriOptions,
  type RequestedDgLabDeviceTauri,
} from './request-device.js';
export {
  TauriBlecOpossumClient,
  type OpossumCommandResult,
  type TauriBlecOpossumClientOptions,
} from './opossum-client.js';
export {
  TauriBlecSensorClient,
  TauriBlecPawPrintsClient,
  TauriBlecCivetEdgingClient,
  type TauriBlecAuxSensorClientOptions,
  type TauriBlecSensorClientOptions,
} from './sensor-client.js';
