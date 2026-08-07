import type { WebBluetoothConnectionContext } from './base.js';
import {
  V3_BATTERY_CHAR,
  V3_BATTERY_SERVICE,
  V3_HANDSHAKE_MTU,
  V3_INIT_PACKET,
  V3_LEGACY_NOTIFY_CHAR,
  V3_LEGACY_SERVICE,
  V3_NORDIC_OTA_CHAR,
  V3_NORDIC_OTA_SERVICE,
  V3_NOTIFY_CHAR,
  V3_PRIMARY_SERVICE,
  V3_WRITE_CHAR,
} from './constants.js';
import type {
  BluetoothRemoteGATTCharacteristicLike,
  BluetoothRemoteGATTServerLike,
} from './types.js';

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

/**
 * The 47L12x-family indicator LED is a discrete 8-color enum, not a
 * continuous byte — confirmed against the community protocol doc's
 * paw-prints color table (0=熄灭/off, 1=黄, 2=红, 3=紫, 4=蓝, 5=青, 6=绿,
 * 7=白) and consistent with civet-edging's one documented example
 * ("01为黄色" — matches index 1 in that same table). Values 8-255 have no
 * defined meaning on real hardware, so every adapter clamps here rather
 * than trusting the caller (a stray remote-control byte or a naive 0-255
 * color picker would otherwise reach the wire unclamped).
 */
export function clampIndicatorColor(color: number): number {
  const value = Number(color);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(7, Math.round(value)));
}

/**
 * Generic clamp-to-integer-range, non-finite input falling back to `min`.
 * Shared by `BaseCoyoteProtocolAdapter` and `OpossumVibrateAdapter` — both
 * clamp raw strength/waveform bytes the identical way before they reach the
 * wire.
 */
export function clampNumber(value: number, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.round(number)));
}

export interface SensorGattConnection {
  writeChar: BluetoothRemoteGATTCharacteristicLike;
  notifyChar: BluetoothRemoteGATTCharacteristicLike;
  deviceName: string;
  address: string;
  battery: number;
}

/**
 * Shared connect sequence for the sensor-family adapters (paw-prints,
 * civet-edging): open the shared 0x180C write/notify characteristics, wire
 * the notification listener, run the V3-family handshake, then a
 * best-effort battery read. Both adapters had this exact sequence
 * byte-for-byte duplicated before this was extracted — kept as a plain
 * function (not a base class) so each adapter's own `onConnected` keeps
 * full control over how/when it constructs and emits its `SensorState`,
 * which differs subtly between them (e.g. paw-prints resets stale chars
 * before a fresh attempt; civet-edging auto-starts pressure streaming right
 * after) and shouldn't be forced into a shared shape.
 */
export async function connectSensorGatt(
  context: WebBluetoothConnectionContext,
  onNotification: (event: Event) => void,
): Promise<SensorGattConnection> {
  const primaryService = await context.server.getPrimaryService(V3_PRIMARY_SERVICE);
  const writeChar = await primaryService.getCharacteristic(V3_WRITE_CHAR);
  const notifyChar = await primaryService.getCharacteristic(V3_NOTIFY_CHAR);
  await notifyChar.startNotifications();
  notifyChar.addEventListener('characteristicvaluechanged', onNotification);

  await performV3FamilyConnectHandshake(context.server, writeChar);

  let battery = 0;
  try {
    const batteryService = await context.server.getPrimaryService(V3_BATTERY_SERVICE);
    const batteryChar = await batteryService.getCharacteristic(V3_BATTERY_CHAR);
    const value = await batteryChar.readValue();
    battery = value.getUint8(0);
  } catch {
    // Best-effort — some firmware/pairing states expose the service but
    // reject the read; a failure here shouldn't fail the whole connection.
    // `battery` already defaults to 0 above.
  }

  return {
    writeChar,
    notifyChar,
    deviceName: context.device.name ?? '',
    address: context.device.id ?? '',
    battery,
  };
}

/**
 * Shared teardown counterpart to `connectSensorGatt` — removes the
 * notification listener and best-effort stops notifications. Safe to call
 * with `notifyChar: null` (e.g. disconnecting before a connection attempt
 * ever got this far).
 */
export async function disconnectSensorGatt(
  notifyChar: BluetoothRemoteGATTCharacteristicLike | null,
  onNotification: (event: Event) => void,
): Promise<void> {
  if (!notifyChar) return;
  notifyChar.removeEventListener('characteristicvaluechanged', onNotification);
  try {
    await notifyChar.stopNotifications();
  } catch {
    // best-effort: device may already be gone.
  }
}
