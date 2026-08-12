import { renderHook, act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useDevicePlayback } from './use-device-playback';

describe('useDevicePlayback', () => {
  it('keeps each device channel playlist independent', () => {
    const { result } = renderHook(() => useDevicePlayback());
    act(() => {
      result.current.get('coyote:one', 'A').toggle('breath');
      result.current.get('opossum', 'A').toggle('tide');
      result.current.get('coyote:two', 'A').setMode('random');
      result.current.get('coyote:two', 'A').setIntervalSec(600);
    });

    expect(result.current.get('coyote:one', 'A').queue).toEqual(['breath']);
    expect(result.current.get('opossum', 'A').queue).toEqual(['tide']);
    expect(result.current.get('coyote:one', 'B').queue).toEqual([]);
    expect(result.current.get('coyote:one', 'A').mode).toBe('single');
    expect(result.current.get('coyote:one', 'A').intervalSec).toBe(30);
    expect(result.current.get('coyote:two', 'A').mode).toBe('random');
    expect(result.current.get('coyote:two', 'A').intervalSec).toBe(600);
  });
});
