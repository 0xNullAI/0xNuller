import { createContext, useContext } from 'react';
import type { DeviceSafetySettings } from '@0xnullai/settings';

/**
 * Games name an intent and the provider turns it into a short, capped device
 * action. Keeping that boundary here stops individual games from inventing
 * their own connection, strength or timing rules.
 */

export type PulseIntensity = 'light' | 'strong';

export interface GamePulseProfile {
  coyoteStrength: number;
  opossumIntensity: number;
  durationMs: number;
  waveformId: 'pulse_low' | 'pulse_mid';
}

const REQUESTS: Record<PulseIntensity, GamePulseProfile> = {
  light: {
    coyoteStrength: 5,
    opossumIntensity: 5,
    durationMs: 250,
    waveformId: 'pulse_low',
  },
  strong: {
    coyoteStrength: 10,
    opossumIntensity: 10,
    durationMs: 450,
    waveformId: 'pulse_mid',
  },
};

/** Resolve a game request against every relevant shared safety ceiling. */
export function resolveGamePulse(
  intensity: PulseIntensity,
  safety: DeviceSafetySettings,
): GamePulseProfile {
  const request = REQUESTS[intensity];
  const coyoteCaps = [request.coyoteStrength, safety.maxStrengthA, safety.maxColdStartStrength];
  if (safety.maxBurstStrengthAbsolute > 0) coyoteCaps.push(safety.maxBurstStrengthAbsolute);
  if (safety.maxBurstStrengthRelative > 0) coyoteCaps.push(safety.maxBurstStrengthRelative);

  return {
    ...request,
    coyoteStrength: Math.max(0, Math.min(...coyoteCaps)),
    opossumIntensity: Math.max(
      0,
      Math.min(request.opossumIntensity, safety.maxIntensityA, safety.maxColdStartIntensity),
    ),
    durationMs: Math.max(0, Math.min(request.durationMs, safety.maxBurstDurationMs)),
  };
}

export interface GameDeviceValue {
  connected: boolean;
  holdsLease: boolean;
  pulse: (intensity: PulseIntensity) => void;
}

const fallback: GameDeviceValue = {
  connected: false,
  holdsLease: false,
  pulse: () => undefined,
};

export const GameDeviceContext = createContext<GameDeviceValue>(fallback);

export function useGameDevice(): GameDeviceValue {
  return useContext(GameDeviceContext);
}
