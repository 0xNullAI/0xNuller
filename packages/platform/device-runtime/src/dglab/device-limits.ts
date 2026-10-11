import type { DeviceKind } from '@dg-kit/core';
import type { BluetoothDeviceLike } from '@dg-kit/protocol';
import {
  loadDeviceLimits,
  removeDeviceLimit,
  subscribeDeviceLimits,
  updateDeviceLimit,
  type DeviceLimitPatch,
  type DeviceOwnLimits,
} from '@0xnullai/settings';

export interface DgLabChannelLimits {
  a: number;
  b: number;
}

/** Where the registry keeps per-device limits. The product uses `@0xnullai/settings`. */
export interface DgLabDeviceLimitStore {
  load(): Record<string, DeviceOwnLimits>;
  update(stableKey: string, patch: DeviceLimitPatch): DeviceOwnLimits;
  remove(stableKey: string): void;
  subscribe(listener: () => void): () => void;
}

/** The app-wide store: local settings, shared by every module and tab. */
export const settingsDeviceLimitStore: DgLabDeviceLimitStore = {
  load: loadDeviceLimits,
  update: updateDeviceLimit,
  remove: removeDeviceLimit,
  subscribe: (listener) => subscribeDeviceLimits(() => listener()),
};

/**
 * A stable, opaque key for one physical device, used only to remember its limits.
 *
 * The registry's target id is per connection (a new pick gets a new id), so it cannot carry a
 * setting across reconnects or restarts. What the transports expose instead:
 * - Web Bluetooth: `device.id`, an origin-scoped id that stays the same while the site keeps
 *   its Bluetooth permission. Clearing site data or revoking it yields a new id, and with it
 *   a device that starts again from the global caps.
 * - Tauri Android (plugin-blec): `device.id` is the BLE address. It is hashed here, so the raw
 *   MAC never reaches storage keys or any UI.
 * - Neither: the advertised name. Same-named devices then share one record; the global caps
 *   still bound each of them, so the trade-off only coarsens the extra limit, never loosens it.
 *
 * Only for remembering limits: routing and dedupe never use this key.
 */
export function deriveDgLabStableKey(kind: DeviceKind, device: BluetoothDeviceLike): string {
  const id = device.id?.trim();
  if (id) return `${kind}:id:${hashIdentity(id)}`;
  const name = device.name?.trim();
  if (name) return `${kind}:name:${hashIdentity(name)}`;
  return `${kind}:unknown`;
}

/**
 * cyrb53: a fast synchronous 53-bit string hash. Not a secret (a BLE address is guessable); it
 * keeps addresses out of storage and display, and 53 bits makes an accidental shared record
 * between two of one user's devices negligible.
 */
function hashIdentity(value: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
