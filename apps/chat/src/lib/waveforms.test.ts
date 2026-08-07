import { describe, it, expect, beforeEach } from 'vitest';
import {
  BUILTIN_WAVEFORMS,
  parsePulseFile,
  loadCustomWaveforms,
  saveCustomWaveforms,
  type WaveformDefinition,
} from './waveforms';

describe('BUILTIN_WAVEFORMS', () => {
  it('contains the 6 expected waveform ids', () => {
    const ids = BUILTIN_WAVEFORMS.map((w) => w.id);
    expect(ids).toEqual(['breath', 'tide', 'pulse_low', 'pulse_mid', 'pulse_high', 'tap']);
  });

  it('every waveform has frames', () => {
    for (const w of BUILTIN_WAVEFORMS) {
      expect(w.frames.length).toBeGreaterThan(0);
      expect(w.frames[0]?.length).toBe(2);
    }
  });

  it('intensity values are clamped to 0..100', () => {
    for (const w of BUILTIN_WAVEFORMS) {
      for (const [, intensity] of w.frames) {
        expect(intensity).toBeGreaterThanOrEqual(0);
        expect(intensity).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe('parsePulseFile', () => {
  it('returns null for non-pulse content', () => {
    expect(parsePulseFile('hello world')).toBeNull();
    expect(parsePulseFile('')).toBeNull();
  });

  it('parses a minimal valid .pulse file', () => {
    const text = 'Dungeonlab+pulse:测试=0,0,0,1,1/0,100';
    const result = parsePulseFile(text);
    expect(result).not.toBeNull();
    expect(result!.frames.length).toBeGreaterThan(0);
    expect(result!.custom).toBe(true);
  });

  it('strips BOM at start', () => {
    const text = '﻿Dungeonlab+pulse:测试=0,0,0,1,1/0,100';
    const result = parsePulseFile(text);
    expect(result).not.toBeNull();
  });

  it('returns null when no enabled section is present', () => {
    // header field [4] = '0' means disabled
    const text = 'Dungeonlab+pulse:test=0,0,0,1,0/0,100';
    expect(parsePulseFile(text)).toBeNull();
  });

  it('returns null when section is missing the / separator', () => {
    const text = 'Dungeonlab+pulse:test=invalid';
    expect(parsePulseFile(text)).toBeNull();
  });
});

describe('localStorage persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns empty array when nothing stored', () => {
    expect(loadCustomWaveforms()).toEqual([]);
  });

  it('round-trips a list through save + load', () => {
    const sample: WaveformDefinition[] = [
      {
        id: 'custom-1',
        name: '测试 1',
        description: '一个测试波形',
        frames: [
          [10, 50],
          [10, 100],
        ],
        custom: true,
      },
    ];
    saveCustomWaveforms(sample);
    expect(loadCustomWaveforms()).toEqual(sample);
  });

  it('returns empty when stored value is corrupt JSON', () => {
    localStorage.setItem('dg-chat-custom-waveforms', '{not valid json');
    expect(loadCustomWaveforms()).toEqual([]);
  });
});
