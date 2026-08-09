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

/** One attached Coyote host. */
export interface AttachedCoyoteState {
  /** Stable per-device identity (BLE address / BluetoothDevice.id). */
  id: string;
  name: string;
  connected: boolean;
  battery: number | null;
  strengthA: number;
  strengthB: number;
  limitA: number;
  limitB: number;
}

/** The subset of `useDevice()`'s return value these summaries are built from. */
export interface AttachedDeviceState {
  /** Every attached Coyote host, primary first. */
  coyotes: AttachedCoyoteState[];
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
 * True while any DG-Lab device is attached — any Coyote, Opossum, or either sensor.
 *
 * "Holds a connected device", not "is currently outputting": a stop button that
 * appears only while output is running is missing at the exact moment somebody
 * reaches for it.
 */
export function holdsAnyDevice(device: AttachedDeviceState): boolean {
  return (
    device.coyotes.some((c) => c.connected) ||
    Boolean(device.opossum?.connected) ||
    Boolean(device.sensor?.connected)
  );
}

/**
 * Disambiguate hosts that advertise the same BLE name.
 *
 * Two Coyotes of the same model advertise the *same* name, so a bar showing
 * "47L121000" twice tells the user nothing about which one is at 30 and which
 * is at 5. Numbering only kicks in on an actual collision, so the ordinary
 * one-device case keeps reading as the plain device name.
 */
function labelCoyotes(coyotes: AttachedCoyoteState[]): Map<string, string> {
  // Normalise first: an unnamed host must still get a label, and two unnamed
  // hosts must still be told apart.
  const named = coyotes.map((c) => ({ id: c.id, name: c.name || '郊狼' }));

  const counts = new Map<string, number>();
  for (const c of named) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);

  const seen = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const c of named) {
    if ((counts.get(c.name) ?? 0) < 2) {
      labels.set(c.id, c.name);
      continue;
    }
    const n = (seen.get(c.name) ?? 0) + 1;
    seen.set(c.name, n);
    labels.set(c.id, `${c.name} #${n}`);
  }
  return labels;
}

/**
 * One entry per attached device, for the shell's device bar.
 *
 * Every Coyote gets its own entry, keyed by its own device id. They used to
 * all report `id: 'coyote'`, which made the bar's `sessionId:deviceId` key
 * collide so React rendered only the first — the user lost the only on-screen
 * confirmation that a second device was attached to their body.
 *
 * The sensor slot holds at most one sensor at a time (paw-prints OR
 * civet-edging, see DeviceSession), so it reports under its actual kind rather
 * than a generic "sensor" — the bar has to name what is on the body.
 */
export function attachedDeviceSummaries(device: AttachedDeviceState): DeviceSummary[] {
  const summaries: DeviceSummary[] = [];

  const connectedCoyotes = device.coyotes.filter((c) => c.connected);
  const labels = labelCoyotes(connectedCoyotes);
  for (const coyote of connectedCoyotes) {
    summaries.push({
      id: coyote.id,
      kind: 'coyote',
      name: labels.get(coyote.id) ?? coyote.name ?? '郊狼',
      connected: true,
      ...(typeof coyote.battery === 'number' ? { battery: coyote.battery } : {}),
      active: coyote.strengthA > 0 || coyote.strengthB > 0,
      channels: [
        { label: 'A', value: coyote.strengthA, max: coyote.limitA },
        { label: 'B', value: coyote.strengthB, max: coyote.limitB },
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
