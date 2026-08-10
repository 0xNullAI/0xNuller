import { DEFAULT_DEVICE_SAFETY } from '@0xnullai/settings';
import { resolveGamePulse } from './use-game-device';

describe('resolveGamePulse', () => {
  it('maps game intents to conservative defaults', () => {
    expect(resolveGamePulse('light', DEFAULT_DEVICE_SAFETY)).toEqual({
      coyoteStrength: 5,
      opossumIntensity: 5,
      durationMs: 250,
      waveformId: 'pulse_low',
    });
    expect(resolveGamePulse('strong', DEFAULT_DEVICE_SAFETY)).toEqual({
      coyoteStrength: 10,
      opossumIntensity: 10,
      durationMs: 450,
      waveformId: 'pulse_mid',
    });
  });

  it('obeys shared strength, cold-start, burst and duration ceilings', () => {
    const request = resolveGamePulse('strong', {
      ...DEFAULT_DEVICE_SAFETY,
      maxStrengthA: 9,
      maxColdStartStrength: 8,
      maxBurstStrengthAbsolute: 7,
      maxBurstStrengthRelative: 6,
      maxIntensityA: 5,
      maxColdStartIntensity: 4,
      maxBurstDurationMs: 200,
    });

    expect(request).toMatchObject({
      coyoteStrength: 6,
      opossumIntensity: 4,
      durationMs: 200,
    });
  });

  it('disables feedback when an applicable ceiling is zero', () => {
    const request = resolveGamePulse('light', {
      ...DEFAULT_DEVICE_SAFETY,
      maxStrengthA: 0,
      maxIntensityA: 0,
      maxBurstDurationMs: 0,
    });

    expect(request.coyoteStrength).toBe(0);
    expect(request.opossumIntensity).toBe(0);
    expect(request.durationMs).toBe(0);
  });
});
