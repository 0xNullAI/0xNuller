import type { RequestDeviceOptionsLike } from './types.js';

// V3 (Coyote 3.0)
export const V3_DEVICE_NAME_PREFIX = '47L121';
export const V3_SENSOR_NAME_PREFIX = '47L120';
export const V3_PRIMARY_SERVICE = '0000180c-0000-1000-8000-00805f9b34fb';
export const V3_WRITE_CHAR = '0000150a-0000-1000-8000-00805f9b34fb';
export const V3_NOTIFY_CHAR = '0000150b-0000-1000-8000-00805f9b34fb';
export const V3_BATTERY_SERVICE = '0000180a-0000-1000-8000-00805f9b34fb';
export const V3_BATTERY_CHAR = '00001500-0000-1000-8000-00805f9b34fb';

// V2 (Coyote 2.0)
export const V2_DEVICE_NAME_PREFIX = 'D-LAB ESTIM';
export const v2Uuid = (short: string): string => `955a${short}-0fe2-f5aa-a094-84b8d4f3e8ad`;
export const V2_PRIMARY_SERVICE = v2Uuid('180b');
export const V2_STRENGTH_CHAR = v2Uuid('1504');
export const V2_WAVE_A_CHAR = v2Uuid('1505');
export const V2_WAVE_B_CHAR = v2Uuid('1506');
export const V2_BATTERY_SERVICE = v2Uuid('180a');
export const V2_BATTERY_CHAR = v2Uuid('1500');

// V3 connect handshake. Reverse-engineering the official app
// (DeviceManager.initOta(), run on every successful connection, not just
// before flashing) shows it always sends a fixed 4-step sequence before the
// device will act on normal B0/BF control writes: an init packet on the
// write characteristic, best-effort subscription to two legacy/OTA notify
// channels, and an MTU bump. Newer firmware appears to require this before
// it accepts control traffic — skipping it (as this library previously did)
// reads as "device won't respond" after a firmware update.
export const V3_INIT_PACKET = new Uint8Array([0x50, 0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
export const V3_LEGACY_SERVICE = '0000ff0a-0000-1000-8000-00805f9b34fb';
export const V3_LEGACY_NOTIFY_CHAR = '0000ff00-0000-1000-8000-00805f9b34fb';
export const V3_NORDIC_OTA_SERVICE = 'f000ffc0-0451-4000-b000-000000000000';
export const V3_NORDIC_OTA_CHAR = 'f000ffc2-0451-4000-b000-000000000000';
export const V3_HANDSHAKE_MTU = 140;

export const COYOTE_REQUEST_DEVICE_OPTIONS: RequestDeviceOptionsLike = {
  filters: [
    { namePrefix: V3_DEVICE_NAME_PREFIX },
    { namePrefix: V3_SENSOR_NAME_PREFIX },
    { namePrefix: V2_DEVICE_NAME_PREFIX },
  ],
  optionalServices: [
    V3_PRIMARY_SERVICE,
    V3_BATTERY_SERVICE,
    V2_PRIMARY_SERVICE,
    V2_BATTERY_SERVICE,
    V3_LEGACY_SERVICE,
    V3_NORDIC_OTA_SERVICE,
  ],
};
