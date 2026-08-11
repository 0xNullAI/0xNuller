import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DeviceSession } from '@voice/lib/device-session';
import type { VoiceSettings } from '@voice/lib/settings';
import { useRealtimeCall } from './use-realtime-call';

describe('useRealtimeCall 正常结束', () => {
  it('模块切换的内部原因不会显示成红色服务错误', async () => {
    const emergencyStop = vi.fn(async () => undefined);
    const { result } = renderHook(() =>
      useRealtimeCall({ emergencyStop } as unknown as DeviceSession, {} as VoiceSettings),
    );

    await act(async () => {
      await result.current.hangUp('切换到其他模块');
    });

    expect(emergencyStop).toHaveBeenCalledTimes(1);
    expect(result.current.state.status).toBe('ended');
    expect(result.current.state.error).toBeNull();
  });
});
