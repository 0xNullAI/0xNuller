import { describe, it, expect } from 'vitest';
import type { CmdAction, DeviceCommand, MemberState, StateFast, StateSlow } from './protocol';

/**
 * These are mostly type-level regression guards: `satisfies` forces the
 * object literals below to stay in sync with the interfaces as fields get
 * renamed/removed, which is where the real risk lives for this file (no
 * runtime logic beyond plain data shapes). Kept as `it()` blocks (not bare
 * type-only assertions) so `tsc` failures show up as normal test failures
 * too, not just as a separate build step.
 */
describe('DeviceCommand — new device-kind fields', () => {
  it('accepts the new vibrate_* / set_led actions with kind/color/ms', () => {
    const actions: CmdAction[] = ['vibrate_adjust', 'vibrate_stop', 'vibrate_burst', 'set_led'];
    expect(actions).toHaveLength(4);

    const vibrateAdjust = {
      action: 'vibrate_adjust',
      kind: 'opossum',
      c: 'A',
      v: 5,
    } satisfies DeviceCommand;
    expect(vibrateAdjust.kind).toBe('opossum');

    const vibrateBurst = {
      action: 'vibrate_burst',
      kind: 'opossum',
      c: 'B',
      v: 120,
      ms: 500,
    } satisfies DeviceCommand;
    expect(vibrateBurst.ms).toBe(500);

    const setLed = {
      action: 'set_led',
      kind: 'paw-prints',
      color: 128,
    } satisfies DeviceCommand;
    expect(setLed.color).toBe(128);
  });

  it('omitting `kind` keeps the historical "means Coyote" meaning for existing actions', () => {
    const legacy: DeviceCommand = { action: 'adjust_strength', c: 'A', v: 3 };
    expect(legacy.kind).toBeUndefined();
  });
});

describe('MemberState — Opossum / sensor fields', () => {
  it('supports an Opossum-only member (no sensor connected)', () => {
    const member: MemberState = {
      peerId: 'p1',
      displayName: 'Alice',
      deviceConnected: true,
      strengthA: 0,
      strengthB: 0,
      waveA: null,
      waveB: null,
      battery: 80,
      queueA: [],
      queueB: [],
      playModeA: 'single',
      playModeB: 'single',
      intervalA: 30,
      intervalB: 30,
      currentIndexA: 0,
      currentIndexB: 0,
      firingA: false,
      firingB: false,
      opossumConnected: true,
      opossumIntensityA: 40,
      opossumIntensityB: 0,
      opossumBattery: 90,
    };

    expect(member.opossumConnected).toBe(true);
    expect(member.sensorKind).toBeUndefined();
  });

  it('supports a sensor-only member (paw-prints) with an informational last event', () => {
    const member: MemberState = {
      peerId: 'p2',
      displayName: 'Bob',
      deviceConnected: true,
      strengthA: 0,
      strengthB: 0,
      waveA: null,
      waveB: null,
      battery: null,
      queueA: [],
      queueB: [],
      playModeA: 'single',
      playModeB: 'single',
      intervalA: 30,
      intervalB: 30,
      currentIndexA: 0,
      currentIndexB: 0,
      firingA: false,
      firingB: false,
      sensorKind: 'paw-prints',
      sensorConnected: true,
      sensorBattery: 55,
      sensorLastEvent: '触发事件 #1（参数 3）',
      sensorLastValue: 3,
      sensorLastEventAt: Date.now(),
    };

    expect(member.sensorKind).toBe('paw-prints');
    expect(member.opossumConnected).toBeUndefined();
  });
});

describe('StateFast / StateSlow — wire split for the new fields', () => {
  it('puts frequently-changing Opossum intensity + sensor events on the fast channel', () => {
    const fast = {
      strengthA: 10,
      strengthB: 0,
      waveA: null,
      waveB: null,
      firingA: false,
      firingB: false,
      opossumIntensityA: 20,
      opossumIntensityB: 0,
      sensorLastEvent: '压力 12.3 kPa',
      sensorLastValue: 12.3,
      sensorLastEventAt: Date.now(),
    } satisfies StateFast;
    expect(fast.opossumIntensityA).toBe(20);
  });

  it('puts connection/battery/kind on the slow (heartbeat) channel', () => {
    const slow = {
      displayName: 'Alice',
      deviceConnected: true,
      battery: 80,
      queueA: [],
      queueB: [],
      playModeA: 'single',
      playModeB: 'single',
      intervalA: 30,
      intervalB: 30,
      currentIndexA: 0,
      currentIndexB: 0,
      opossumConnected: true,
      opossumBattery: 90,
      sensorKind: 'civet-edging',
      sensorConnected: true,
      sensorBattery: 55,
    } satisfies StateSlow;
    expect(slow.sensorKind).toBe('civet-edging');
  });
});
