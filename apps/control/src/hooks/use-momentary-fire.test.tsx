import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CoyoteSummary } from '../../../chat/src/lib/bluetooth';
import { useMomentaryFire } from './use-momentary-fire';

function coyote(overrides: Partial<CoyoteSummary> = {}): CoyoteSummary {
  return {
    id: 'coyote-1',
    name: '47L121000',
    version: 'v3',
    connected: true,
    battery: 80,
    strengthA: 5,
    strengthB: 0,
    limitA: 20,
    limitB: 20,
    waveActiveA: true,
    waveActiveB: false,
    waveIdA: 'breath',
    waveIdB: null,
    ...overrides,
  };
}

describe('useMomentaryFire', () => {
  it('按住时在当前强度上增加，松开恢复原值', () => {
    const setStrength = vi.fn();
    const { result } = renderHook(() =>
      useMomentaryFire({ coyotes: [coyote()], released: false, setStrength }),
    );

    act(() => result.current.start('coyote-1', 'A', 7));
    expect(setStrength).toHaveBeenLastCalledWith('A', 12, 'coyote-1');
    expect(result.current.firingDeviceIds.A).toBe('coyote-1');

    act(() => result.current.stop('A'));
    expect(setStrength).toHaveBeenLastCalledWith('A', 5, 'coyote-1');
    expect(result.current.firingDeviceIds.A).toBeNull();
  });

  it('未运行波形的通道不能开火', () => {
    const setStrength = vi.fn();
    const { result } = renderHook(() =>
      useMomentaryFire({ coyotes: [coyote()], released: false, setStrength }),
    );
    act(() => result.current.start('coyote-1', 'B', 7));
    expect(setStrength).not.toHaveBeenCalled();
  });

  it('提升值仍受通道上限约束', () => {
    const setStrength = vi.fn();
    const { result } = renderHook(() =>
      useMomentaryFire({
        coyotes: [coyote({ strengthA: 18 })],
        released: false,
        setStrength,
      }),
    );
    act(() => result.current.start('coyote-1', 'A', 7));
    expect(setStrength).toHaveBeenCalledWith('A', 20, 'coyote-1');
  });

  it('急停取消后，迟到的 pointerup 不会恢复旧强度', () => {
    const setStrength = vi.fn();
    const { result } = renderHook(() =>
      useMomentaryFire({ coyotes: [coyote()], released: false, setStrength }),
    );
    act(() => result.current.start('coyote-1', 'A', 7));
    act(() => result.current.cancel());
    act(() => result.current.stop('A'));
    expect(setStrength).toHaveBeenCalledTimes(1);
  });
});
