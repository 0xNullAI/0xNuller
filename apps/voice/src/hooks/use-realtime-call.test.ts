import { act, renderHook, waitFor } from '@testing-library/react';
import { createEmptyDeviceState } from '@dg-kit/core';
import { createEmptyOpossumState } from '@dg-kit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeviceSession } from '@voice/lib/device-session';
import { createDefaultSettings, type VoiceSettings } from '@voice/lib/settings';
import type { RealtimeSession, RealtimeSessionOptions } from '@voice/lib/realtime/realtime-session';
import { useRealtimeCall } from './use-realtime-call';

const realtimeMocks = vi.hoisted(() => ({ createSession: vi.fn() }));
vi.mock('@voice/lib/realtime/realtime-session', async (importOriginal) => ({
  ...(await importOriginal()),
  createRealtimeSession: realtimeMocks.createSession,
}));

afterEach(() => {
  vi.useRealTimers();
  realtimeMocks.createSession.mockReset();
});

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

  it('updates the model tool allowlist on topology changes without reconnecting', async () => {
    let state = {
      coyote: createEmptyDeviceState(),
      opossum: createEmptyOpossumState(),
    };
    let changed: () => void = () => undefined;
    const deviceSession = {
      coyote: {},
      opossum: {},
      getState: vi.fn(async () => state),
      onChanged: vi.fn((listener: () => void) => {
        changed = listener;
        return vi.fn();
      }),
      emergencyStop: vi.fn(async () => undefined),
    } as unknown as DeviceSession;
    const updateConfiguration = vi.fn();
    const realtimeSession = {
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(),
      updateConfiguration,
      updateInstructions: vi.fn(),
      isConnected: () => true,
      sendFunctionCallOutput: vi.fn(),
      requestResponse: vi.fn(),
      whenAudioDrained: vi.fn(async () => undefined),
    } satisfies RealtimeSession;
    realtimeMocks.createSession.mockResolvedValue(realtimeSession);
    const settings = createDefaultSettings();
    settings.providers.xai.apiKey = 'test-key';

    const { result } = renderHook(() => useRealtimeCall(deviceSession, settings));
    await act(async () => result.current.startCall());

    const initial = realtimeMocks.createSession.mock.calls[0]?.[0] as RealtimeSessionOptions;
    expect(initial.tools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(['shock_start', 'vibrate_start']),
    );

    state = { ...state, coyote: { ...state.coyote, connected: true } };
    act(() => changed());
    await waitFor(() =>
      expect(updateConfiguration).toHaveBeenLastCalledWith(
        expect.objectContaining({
          tools: expect.arrayContaining([expect.objectContaining({ name: 'shock_start' })]),
        }),
      ),
    );
    const connectedUpdate = updateConfiguration.mock.calls.at(-1)?.[0] as {
      tools: Array<{ name: string }>;
    };
    expect(connectedUpdate.tools.map((tool) => tool.name)).not.toContain('vibrate_start');

    state = { ...state, coyote: { ...state.coyote, connected: false } };
    act(() => changed());
    await waitFor(() => {
      const latest = updateConfiguration.mock.calls.at(-1)?.[0] as {
        tools: Array<{ name: string }>;
      };
      expect(latest.tools.map((tool) => tool.name)).not.toContain('shock_start');
    });
    const disconnectedUpdate = updateConfiguration.mock.calls.at(-1)?.[0] as {
      instructions: string;
      tools: Array<{ name: string }>;
    };
    expect(disconnectedUpdate.instructions).not.toContain('郊狼');
    expect(disconnectedUpdate.tools.map((tool) => tool.name)).not.toContain('shock_start');
    expect(realtimeMocks.createSession).toHaveBeenCalledTimes(1);
    expect(realtimeSession.disconnect).not.toHaveBeenCalled();
  }, 10_000);
});
