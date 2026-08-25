import type { DeviceSummary } from '@dg-kit/safety';
import { isCoyoteOutputActive, type OpossumVibrationPatternName } from '@dg-kit/core';

export type DeviceVersion = 'v2' | 'v3';

/** Product-wide UI snapshot for one attached Coyote host. */
export interface CoyoteSummary {
  /** Stable device identity (BluetoothDevice.id / native BLE address). */
  id: string;
  name: string;
  version: DeviceVersion;
  connected: boolean;
  battery: number | null;
  strengthA: number;
  strengthB: number;
  limitA: number;
  limitB: number;
  waveActiveA: boolean;
  waveActiveB: boolean;
  waveIdA: string | null;
  waveIdB: string | null;
}

export type SensorKind = 'paw-prints' | 'civet-edging';

/** Product-wide UI snapshot for the single attached sensor slot. */
export interface SensorSummary {
  kind: SensorKind;
  connected: boolean;
  deviceName: string;
  battery: number | null;
  lastEvent: string | null;
  lastValue: number | null;
  lastEventAt: number | null;
}

/** Product-wide UI snapshot for the attached Opossum output. */
export interface OpossumSummary {
  connected: boolean;
  deviceName: string;
  battery: number | null;
  intensityA: number;
  intensityB: number;
  limitA: number;
  limitB: number;
  waveIdA: string | null;
  waveIdB: string | null;
  lastButtons: string | null;
  lastButtonsAt: number | null;
  patternA?: OpossumVibrationPatternName;
  patternB?: OpossumVibrationPatternName;
}

/** The device state needed to populate the shell's global device bar. */
export interface AttachedDeviceState {
  coyotes: readonly CoyoteSummary[];
  sensor: SensorSummary | null;
  opossum: OpossumSummary | null;
}

const SENSOR_NAME: Record<SensorKind, string> = {
  'paw-prints': '爪印',
  'civet-edging': '灵猫',
};

/** True while any DG-Lab device is attached, whether or not it is outputting. */
export function holdsAnyDevice(device: AttachedDeviceState): boolean {
  return (
    device.coyotes.some((coyote) => coyote.connected) ||
    Boolean(device.opossum?.connected) ||
    Boolean(device.sensor?.connected)
  );
}

function labelCoyotes(coyotes: readonly CoyoteSummary[]): Map<string, string> {
  const named = coyotes.map((coyote) => ({ id: coyote.id, name: coyote.name || '郊狼' }));
  const counts = new Map<string, number>();
  for (const coyote of named) counts.set(coyote.name, (counts.get(coyote.name) ?? 0) + 1);

  const seen = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const coyote of named) {
    if ((counts.get(coyote.name) ?? 0) < 2) {
      labels.set(coyote.id, coyote.name);
      continue;
    }
    const occurrence = (seen.get(coyote.name) ?? 0) + 1;
    seen.set(coyote.name, occurrence);
    labels.set(coyote.id, `${coyote.name} #${occurrence}`);
  }
  return labels;
}

/** Convert attached-device state into the shell safety bus's display snapshots. */
export function attachedDeviceSummaries(device: AttachedDeviceState): DeviceSummary[] {
  const summaries: DeviceSummary[] = [];
  const connectedCoyotes = device.coyotes.filter((coyote) => coyote.connected);
  const labels = labelCoyotes(connectedCoyotes);

  for (const coyote of connectedCoyotes) {
    summaries.push({
      id: coyote.id,
      kind: 'coyote',
      name: labels.get(coyote.id) ?? coyote.name ?? '郊狼',
      connected: true,
      ...(typeof coyote.battery === 'number' ? { battery: coyote.battery } : {}),
      active: isCoyoteOutputActive(coyote),
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
      channels: [
        { label: 'A', value: device.opossum.intensityA, max: device.opossum.limitA },
        { label: 'B', value: device.opossum.intensityB, max: device.opossum.limitB },
      ],
    });
  }

  if (device.sensor?.connected) {
    summaries.push({
      id: device.sensor.kind,
      kind: device.sensor.kind,
      name: device.sensor.deviceName || SENSOR_NAME[device.sensor.kind],
      connected: true,
      ...(typeof device.sensor.battery === 'number' ? { battery: device.sensor.battery } : {}),
      ...(typeof device.sensor.lastValue === 'number'
        ? {
            readings: [
              {
                value: device.sensor.lastValue,
                ...(device.sensor.kind === 'civet-edging' ? { unit: 'kPa' } : {}),
              },
            ],
          }
        : {}),
    });
  }

  return summaries;
}
