// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCameraPreview } from './use-camera-preview.js';

function mediaStream() {
  const track = { stop: vi.fn(), addEventListener: vi.fn() };
  return {
    track,
    stream: {
      getTracks: () => [track],
      getVideoTracks: () => [track],
    } as unknown as MediaStream,
  };
}

function installMediaDevices(stream: MediaStream) {
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  });
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    value: { query: vi.fn().mockRejectedValue(new Error('unsupported')) },
  });
  return getUserMedia;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('camera preview lifecycle', () => {
  it('does not request a camera until the user explicitly starts it, then stops on hide', async () => {
    const { stream, track } = mediaStream();
    const getUserMedia = installMediaDevices(stream);
    const { result } = renderHook(() => useCameraPreview(true));
    expect(getUserMedia).not.toHaveBeenCalled();

    await act(async () => result.current.start());
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(result.current.state).toBe('on');

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(track.stop).toHaveBeenCalledOnce();
    expect(result.current.state).toBe('off');
  });

  it('stops active tracks when the module unmounts', async () => {
    const { stream, track } = mediaStream();
    installMediaDevices(stream);
    const { result, unmount } = renderHook(() => useCameraPreview(true));
    await act(async () => result.current.start());

    unmount();

    expect(track.stop).toHaveBeenCalledOnce();
  });
});
