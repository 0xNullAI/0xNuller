import {
  V3_HANDSHAKE_MTU,
  V3_INIT_PACKET,
  V3_LEGACY_NOTIFY_CHAR,
  V3_LEGACY_SERVICE,
  V3_NORDIC_OTA_CHAR,
  V3_NORDIC_OTA_SERVICE,
} from './constants.js';
import type { BluetoothRemoteGATTCharacteristicLike, BluetoothRemoteGATTServerLike } from './types.js';

/**
 * Shared GATT write with a fallback chain across the three write methods a
 * characteristic might expose. Standalone (not a class method) so every
 * 47L12x-family adapter can call it without needing to extend
 * `BaseCoyoteProtocolAdapter` — Coyote, paw-prints, civet-edging, and
 * opossum all share this exact write behavior even though their command
 * shapes differ.
 */
export async function writeCharacteristicValue(
  characteristic: BluetoothRemoteGATTCharacteristicLike,
  value: ArrayBufferView | ArrayBuffer,
  options: { preferResponse?: boolean } = {},
): Promise<void> {
  const attempts = options.preferResponse
    ? [
        characteristic.writeValueWithResponse?.bind(characteristic),
        characteristic.writeValueWithoutResponse?.bind(characteristic),
        characteristic.writeValue?.bind(characteristic),
      ]
    : [
        characteristic.writeValueWithoutResponse?.bind(characteristic),
        characteristic.writeValueWithResponse?.bind(characteristic),
        characteristic.writeValue?.bind(characteristic),
      ];

  let lastError: unknown = null;
  for (const attempt of attempts) {
    if (!attempt) continue;
    try {
      await attempt(value);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error('Bluetooth characteristic is not writable');
}

/**
 * Newer firmware (flashed via the official app) ignores normal control
 * writes on the 0x180C/0x150A characteristic until it has seen the same
 * connect-time sequence the app always sends: an init packet, best-effort
 * subscription to two legacy/OTA notify channels, and an MTU bump to 140.
 *
 * The official app sends this exact same init packet unconditionally to
 * every 47L12x-family device it connects to — Coyote, paw-prints,
 * civet-edging, and opossum all share the identical 0x180C GATT skeleton —
 * old and new firmware alike, with no firmware-version detection gating it.
 * So this needs to run for all four device adapters, not just Coyote V3;
 * originally it only ran there, which reproduced the exact "device won't
 * respond" symptom for the three newer device kinds. Every step is
 * best-effort/non-fatal, including the init write itself: if any step fails
 * on a real device this hasn't been tested against, the caller's normal
 * control writes still proceed rather than the connection being refused.
 */
export async function performV3FamilyConnectHandshake(
  server: BluetoothRemoteGATTServerLike,
  writeChar: BluetoothRemoteGATTCharacteristicLike,
): Promise<void> {
  try {
    await writeCharacteristicValue(writeChar, V3_INIT_PACKET);
  } catch {
    // Best-effort — see function comment above.
  }

  try {
    const legacyService = await server.getPrimaryService(V3_LEGACY_SERVICE);
    const legacyChar = await legacyService.getCharacteristic(V3_LEGACY_NOTIFY_CHAR);
    await legacyChar.startNotifications();
  } catch {
    // Not present on this firmware/hardware — non-fatal.
  }

  try {
    const otaService = await server.getPrimaryService(V3_NORDIC_OTA_SERVICE);
    const otaChar = await otaService.getCharacteristic(V3_NORDIC_OTA_CHAR);
    await otaChar.startNotifications();
  } catch {
    // Only present on OTA-capable firmware — non-fatal.
  }

  try {
    await server.requestMTU?.(V3_HANDSHAKE_MTU);
  } catch {
    // Transport may not support MTU negotiation — non-fatal.
  }
}
