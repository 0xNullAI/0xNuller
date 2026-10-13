import { expect, it } from 'vitest';
import { parseRemoteCommand, parseWaveformTransfer } from './remote-command';

it('drops wrongly typed fields so a malformed command is refused, not coerced', () => {
  expect(parseRemoteCommand({ a: 'adjust_strength', c: 'A', v: '50' })).toEqual({
    action: 'adjust_strength',
    c: 'A',
  });
  expect(parseRemoteCommand({ a: 'nope' })).toBeNull();
  expect(parseRemoteCommand({ a: 'set_queue', c: 'C', q: 'w1' })).toEqual({ action: 'set_queue' });
});

it('caps increases per command but never limits lowering output', () => {
  expect(parseRemoteCommand({ a: 'adjust_strength', c: 'A', v: 500 })?.v).toBe(50);
  expect(parseRemoteCommand({ a: 'adjust_strength', c: 'A', v: -180 })?.v).toBe(-180);
  expect(parseRemoteCommand({ a: 'vibrate_adjust', c: 'B', v: 2.6 })?.v).toBe(3);
});

it('keeps intervals, queues and enums in range', () => {
  expect(parseRemoteCommand({ a: 'set_interval', c: 'A', iv: 0 })?.iv).toBe(5);
  expect(parseRemoteCommand({ a: 'set_play_mode', c: 'A', mode: 'chaos' })?.mode).toBeUndefined();
  expect(
    parseRemoteCommand({ a: 'set_queue', c: 'A', q: ['w1', 7, 'x'.repeat(200), 'w2'] })?.q,
  ).toEqual(['w1', 'w2']);
  expect(parseRemoteCommand({ a: 'set_led', kind: 'opossum', color: 99 })?.color).toBe(7);
});

it('accepts a shared waveform only when every frame is a pair of in-range integers', () => {
  const ok = { wid: 'w1', wn: ' 呼吸 ', fr: [[10, 20]] };
  expect(parseWaveformTransfer(ok)).toEqual({
    wid: 'w1',
    wn: '呼吸',
    fr: [[10, 20]],
    modality: 'electrostimulation',
  });
  expect(parseWaveformTransfer({ ...ok, fr: [[10, '20']] })).toBeNull();
  expect(parseWaveformTransfer({ ...ok, fr: [] })).toBeNull();
  expect(parseWaveformTransfer({ ...ok, wid: '../x' })).toBeNull();
  expect(
    parseWaveformTransfer({ ...ok, fr: Array.from({ length: 3001 }, () => [1, 1]) }),
  ).toBeNull();
});
