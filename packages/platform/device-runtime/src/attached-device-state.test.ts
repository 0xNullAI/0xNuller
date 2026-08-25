import { describe, expect, it } from 'vitest';
import {
  attachedDeviceSummaries,
  holdsAnyDevice,
  type AttachedDeviceState,
  type CoyoteSummary,
  type OpossumSummary,
  type SensorSummary,
} from './attached-device-state.js';

function state(overrides: Partial<AttachedDeviceState> = {}): AttachedDeviceState {
  return { coyotes: [], sensor: null, opossum: null, ...overrides };
}

function coyote(overrides: Partial<CoyoteSummary> = {}): CoyoteSummary {
  return {
    id: 'coyote-1',
    name: '47L121000',
    version: 'v3',
    connected: true,
    battery: 88,
    strengthA: 12,
    strengthB: 0,
    limitA: 50,
    limitB: 50,
    waveActiveA: false,
    waveActiveB: false,
    waveIdA: null,
    waveIdB: null,
    ...overrides,
  };
}

const opossum: OpossumSummary = {
  connected: true,
  deviceName: 'Opossum-01',
  battery: 60,
  intensityA: 0,
  intensityB: 5,
  limitA: 40,
  limitB: 60,
  waveIdA: null,
  waveIdB: null,
  lastButtons: null,
  lastButtonsAt: null,
};

const sensor: SensorSummary = {
  kind: 'civet-edging',
  connected: true,
  deviceName: '',
  battery: 42,
  lastEvent: null,
  lastValue: 12.3,
  lastEventAt: null,
};

describe('holdsAnyDevice', () => {
  it('counts every attached device kind without requiring active output', () => {
    expect(holdsAnyDevice(state())).toBe(false);
    expect(holdsAnyDevice(state({ coyotes: [coyote({ strengthA: 0 })] }))).toBe(true);
    expect(holdsAnyDevice(state({ opossum: { ...opossum, intensityB: 0 } }))).toBe(true);
    expect(holdsAnyDevice(state({ sensor }))).toBe(true);
  });

  it('ignores disconnected snapshots', () => {
    expect(
      holdsAnyDevice(
        state({
          coyotes: [coyote({ connected: false })],
          opossum: { ...opossum, connected: false },
          sensor: { ...sensor, connected: false },
        }),
      ),
    ).toBe(false);
  });
});

describe('attachedDeviceSummaries', () => {
  it('preserves distinct Coyote identities, readings, and collision labels', () => {
    const summaries = attachedDeviceSummaries(
      state({
        coyotes: [
          coyote({ id: 'one', waveActiveA: true }),
          coyote({ id: 'two', strengthA: 0, strengthB: 21, limitB: 40 }),
        ],
      }),
    );

    expect(summaries.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'one', name: '47L121000 #1' },
      { id: 'two', name: '47L121000 #2' },
    ]);
    expect(summaries[0]).toMatchObject({
      active: true,
      channels: [
        { label: 'A', value: 12, max: 50 },
        { label: 'B', value: 0, max: 50 },
      ],
    });
    expect(summaries[1]?.channels).toEqual([
      { label: 'A', value: 0, max: 50 },
      { label: 'B', value: 21, max: 40 },
    ]);
  });

  it('requires strength and waveform on the same Coyote channel to report active output', () => {
    expect(
      attachedDeviceSummaries(state({ coyotes: [coyote({ strengthA: 5, waveActiveB: true })] }))[0]
        ?.active,
    ).toBe(false);
  });

  it('maps Opossum and sensor state without inventing unavailable values', () => {
    const summaries = attachedDeviceSummaries(state({ opossum, sensor }));
    expect(summaries[0]).toMatchObject({
      id: 'opossum',
      active: true,
      channels: [
        { label: 'A', value: 0, max: 40 },
        { label: 'B', value: 5, max: 60 },
      ],
    });
    expect(summaries[1]).toMatchObject({
      id: 'civet-edging',
      name: '灵猫',
      readings: [{ value: 12.3, unit: 'kPa' }],
    });
  });

  it('omits disconnected devices and unknown battery fields', () => {
    const summaries = attachedDeviceSummaries(
      state({
        coyotes: [coyote({ battery: null })],
        opossum: { ...opossum, connected: false },
        sensor: { ...sensor, connected: false },
      }),
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).not.toHaveProperty('battery');
  });
});
