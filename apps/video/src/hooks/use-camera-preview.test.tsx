// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cameraEnvironmentError, useCameraPreview } from './use-camera-preview.js';

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

afterEach(() => vi.restoreAllMocks());

describe('camera preview lifecycle', () => {
  it('checks secure context before requesting camera access', () => {
    vi.stubGlobal('isSecureContext', false);
    expect(cameraEnvironmentError()).toMatch(/HTTPS/);
    vi.unstubAllGlobals();
  });

  it('only requests a camera after explicit start and uses the selected lens', async () => {
    const { stream, track } = mediaStream();
    const getUserMedia = installMediaDevices(stream);
    const { result } = renderHook(() => useCameraPreview(true, 'user'));
    expect(getUserMedia).not.toHaveBeenCalled();

    await act(async () => result.current.start());
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: { facingMode: { ideal: 'user' } },
    });

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(track.stop).toHaveBeenCalledOnce();
    expect(result.current.state).toBe('off');
  });

  it('stops active tracks when the module unmounts', async () => {
    const { stream, track } = mediaStream();
    installMediaDevices(stream);
    const { result, unmount } = renderHook(() => useCameraPreview(true, 'environment'));
    await act(async () => result.current.start());
    unmount();
    expect(track.stop).toHaveBeenCalledOnce();
  });
});
