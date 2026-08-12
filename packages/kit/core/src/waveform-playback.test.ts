import { describe, expect, it } from 'vitest';
import {
  getWaveformModality,
  isWaveformCompatibleWithDevice,
  startWaveformId,
  toggleQueueEntry,
} from './waveform-playback.js';

describe('shared waveform and playback rules', () => {
  it('treats legacy waveforms as electrostimulation and filters by output kind', () => {
    expect(getWaveformModality({})).toBe('electrostimulation');
    expect(isWaveformCompatibleWithDevice('coyote', {})).toBe(true);
    expect(isWaveformCompatibleWithDevice('opossum', {})).toBe(false);
    expect(isWaveformCompatibleWithDevice('opossum', { modality: 'vibration' })).toBe(true);
    expect(isWaveformCompatibleWithDevice('coyote', { modality: 'vibration' })).toBe(false);
  });

  it('keeps queue toggling and index normalization identical across modules', () => {
    expect(toggleQueueEntry(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleQueueEntry(['a', 'b'], 'a')).toEqual(['b']);
    expect(startWaveformId(['a', 'b'], -1)).toBe('b');
    expect(startWaveformId(['a', 'b'], 3)).toBe('b');
    expect(startWaveformId([], 0)).toBeNull();
  });
});
