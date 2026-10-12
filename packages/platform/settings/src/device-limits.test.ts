import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadDeviceLimit,
  loadDeviceLimits,
  removeDeviceLimit,
  subscribeDeviceLimits,
  updateDeviceLimit,
} from './device-limits';

const KEY = '0xnullai.device-limits';

beforeEach(() => {
  localStorage.clear();
});

describe('per-device limits', () => {
  it('starts empty and remembers a new device with no extra restriction', () => {
    expect(loadDeviceLimits()).toEqual({});
    expect(updateDeviceLimit('coyote:id:x', { kind: 'coyote', name: '47L121000' })).toEqual({
      kind: 'coyote',
      a: 200,
      b: 200,
      name: '47L121000',
    });
    expect(loadDeviceLimit('coyote:id:x')).toMatchObject({ a: 200, b: 200 });
  });

  it('persists, keeps the other channel, and clamps to 0..200', () => {
    updateDeviceLimit('coyote:id:x', { kind: 'coyote', a: 30 });
    updateDeviceLimit('coyote:id:x', { kind: 'coyote', b: 999 });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({
      'coyote:id:x': { kind: 'coyote', a: 30, b: 200 },
    });
    expect(updateDeviceLimit('coyote:id:x', { kind: 'coyote', a: -5, b: 12.6 })).toMatchObject({
      a: 0,
      b: 13,
    });
    expect(updateDeviceLimit('coyote:id:x', { kind: 'coyote', a: Number.NaN })).toMatchObject({
      a: 0,
    });
  });

  it.each([
    ['not JSON', '{坏'],
    ['an array', '[1,2]'],
    ['a string', '"x"'],
  ])('reads %s as no records instead of throwing', (_label, raw) => {
    localStorage.setItem(KEY, raw);
    expect(() => loadDeviceLimits()).not.toThrow();
    expect(loadDeviceLimits()).toEqual({});
  });

  it('drops corrupted records and keeps valid ones', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        good: { kind: 'opossum', a: 40, b: 250 },
        noKind: { a: 10, b: 10 },
        badKind: { kind: 'paw-prints', a: 10, b: 10 },
        textA: { kind: 'coyote', a: '10', b: 10 },
        nanB: { kind: 'coyote', a: 10, b: null },
        notObject: 5,
        '  ': { kind: 'coyote', a: 1, b: 1 },
      }),
    );
    expect(loadDeviceLimits()).toEqual({ good: { kind: 'opossum', a: 40, b: 200 } });
  });

  it('removes a record and notifies subscribers on every change', () => {
    const seen = vi.fn();
    const off = subscribeDeviceLimits(seen);
    updateDeviceLimit('k', { kind: 'coyote', a: 20 });
    // An unchanged write is not a change.
    updateDeviceLimit('k', { kind: 'coyote', a: 20 });
    removeDeviceLimit('k');
    removeDeviceLimit('k');
    off();
    expect(seen).toHaveBeenCalledTimes(2);
    expect(seen.mock.calls[0]![0]).toEqual({ k: { kind: 'coyote', a: 20, b: 200 } });
    expect(seen.mock.calls[1]![0]).toEqual({});
    expect(loadDeviceLimit('k')).toBeNull();
  });

  it('starts a record fresh when a key is reused for the other kind', () => {
    updateDeviceLimit('k', { kind: 'coyote', a: 20, b: 20 });
    expect(updateDeviceLimit('k', { kind: 'opossum', a: 70 })).toEqual({
      kind: 'opossum',
      a: 70,
      b: 200,
    });
  });

  it('keeps a lowered limit for the session when storage refuses the write', () => {
    updateDeviceLimit('k', { kind: 'coyote', a: 80 });
    const stored = localStorage.getItem(KEY);
    vi.stubGlobal('localStorage', {
      getItem: () => stored,
      setItem: () => {
        throw new Error('quota');
      },
    });
    try {
      updateDeviceLimit('k', { kind: 'coyote', a: 10 });
      expect(loadDeviceLimit('k')).toMatchObject({ a: 10 });
    } finally {
      vi.unstubAllGlobals();
    }
    // The next successful write persists and ends the in-memory override.
    updateDeviceLimit('k', { kind: 'coyote', b: 15 });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({
      k: { kind: 'coyote', a: 10, b: 15 },
    });
  });
});
