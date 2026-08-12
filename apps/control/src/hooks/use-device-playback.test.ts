import { renderHook, act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useDevicePlayback } from './use-device-playback';

describe('useDevicePlayback', () => {
  it('keeps each device channel playlist independent', () => {
    const { result } = renderHook(() => useDevicePlayback());
    act(() => {
      result.current.get('coyote:one', 'A').toggle('breath');
      result.current.get('opossum', 'A').toggle('tide');
    });

    expect(result.current.get('coyote:one', 'A').queue).toEqual(['breath']);
    expect(result.current.get('opossum', 'A').queue).toEqual(['tide']);
    expect(result.current.get('coyote:one', 'B').queue).toEqual([]);
  });
});
