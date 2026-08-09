import type { DeviceSummary } from '@dg-kit/safety';

/**
 * What Control tells the safety bus it is holding.
 *
 * This is the shell's ONLY source for the global stop button and the device
 * bar. Chat shipped a version of this that looked at the Coyote alone, so a
 * session holding only an Opossum reported "no devices, not active" and the
 * shell rendered no stop button at all while something was running on the
 * user's body. Every attached device counts here, and the two functions are
 * separated out precisely so that claim can be tested rather than reviewed.
 */

/** The subset of `useDevice()`'s return value these summaries are built from. */
export interface AttachedDeviceState {
  connected: boolean;
  deviceInfo: { name: string } | null;
  battery: number | null;
  strengthA: number;
  strengthB: number;
  limitA: number;
  limitB: number;
  sensor: {
    kind: string;
    connected: boolean;
    deviceName: string;
    battery: number | null;
  } | null;
  opossum: {
    connected: boolean;
    deviceName: string;
    battery: number | null;
    intensityA: number;
    intensityB: number;
  } | null;
}

const SENSOR_NAME: Record<string, string> = {
  'paw-prints': '爪印',
  'civet-edging': '灵猫',
};

/**
 * True while any DG-Lab device is attached — Coyote, Opossum, or either sensor.
 *
 * "Holds a connected device", not "is currently outputting": a stop button that
 * appears only while output is running is missing at the exact moment somebody
 * reaches for it.
 */
export function holdsAnyDevice(device: AttachedDeviceState): boolean {
  return (
    device.connected || Boolean(device.opossum?.connected) || Boolean(device.sensor?.connected)
  );
}

/**
 * One entry per attached device, for the shell's device bar.
 *
 * The sensor slot holds at most one sensor at a time (paw-prints OR
 * civet-edging, see DeviceSession), so it reports under its actual kind rather
 * than a generic "sensor" — the bar has to name what is on the body.
 */
export function attachedDeviceSummaries(device: AttachedDeviceState): DeviceSummary[] {
  const summaries: DeviceSummary[] = [];

  if (device.connected) {
    summaries.push({
      id: 'coyote',
      kind: 'coyote',
      name: device.deviceInfo?.name ?? '郊狼',
      connected: true,
      ...(typeof device.battery === 'number' ? { battery: device.battery } : {}),
      active: device.strengthA > 0 || device.strengthB > 0,
      channels: [
        { label: 'A', value: device.strengthA, max: device.limitA },
        { label: 'B', value: device.strengthB, max: device.limitB },
      ],
    });
  }

  if (device.opossum?.connected) {
    summaries.push({
      id: 'opossum',
      kind: 'opossum',
      name: device.opossum.deviceName || '负鼠',
      connected: true,
      ...(typeof device.opossum.battery === 'number' ? { battery: device.opossum.battery } : {}),
      active: device.opossum.intensityA > 0 || device.opossum.intensityB > 0,
    });
  }

  if (device.sensor?.connected) {
    summaries.push({
      id: device.sensor.kind,
      kind: device.sensor.kind,
      name: device.sensor.deviceName || SENSOR_NAME[device.sensor.kind] || device.sensor.kind,
      connected: true,
      ...(typeof device.sensor.battery === 'number' ? { battery: device.sensor.battery } : {}),
    });
  }

  return summaries;
}
