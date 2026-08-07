import {
  CIVET_DEVICE_NAME_PREFIX,
  OPOSSUM_DEVICE_NAME_PREFIX,
  PAW_PRINTS_DEVICE_NAME_PREFIX,
  V3_BATTERY_SERVICE,
  V3_PRIMARY_SERVICE,
  type RequestDeviceOptionsLike,
} from '@dg-kit/protocol';

/**
 * Per-kind Web Bluetooth scan filters for the three new 47L12x-family device
 * kinds, each scoped to just that kind's name prefix.
 *
 * Deliberately narrower than `@dg-kit/protocol`'s `DG_LAB_REQUEST_DEVICE_OPTIONS`
 * (which matches every known kind in a single picker). A caller giving each
 * kind its own dedicated connect button should use these so the chooser it
 * opens only ever lists devices of that one kind.
 *
 * All four 47L12x-family kinds (Coyote V3 included) share the identical
 * primary/battery GATT services, so only the name-prefix filter differs
 * between these three constants.
 */
export const PAW_PRINTS_REQUEST_DEVICE_OPTIONS: RequestDeviceOptionsLike = {
  filters: [{ namePrefix: PAW_PRINTS_DEVICE_NAME_PREFIX }],
  optionalServices: [V3_PRIMARY_SERVICE, V3_BATTERY_SERVICE],
};

export const CIVET_EDGING_REQUEST_DEVICE_OPTIONS: RequestDeviceOptionsLike = {
  filters: [{ namePrefix: CIVET_DEVICE_NAME_PREFIX }],
  optionalServices: [V3_PRIMARY_SERVICE, V3_BATTERY_SERVICE],
};

export const OPOSSUM_REQUEST_DEVICE_OPTIONS: RequestDeviceOptionsLike = {
  filters: [{ namePrefix: OPOSSUM_DEVICE_NAME_PREFIX }],
  optionalServices: [V3_PRIMARY_SERVICE, V3_BATTERY_SERVICE],
};
