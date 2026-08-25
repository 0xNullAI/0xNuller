// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CAMERA_FRAME_SETTINGS } from '../services/camera-frame.js';
import {
  cameraEnvironmentError,
  ensureAndroidCameraPermission,
  useCameraPreview,
} from './use-camera-preview.js';

const captureCameraFrame = vi.hoisted(() => vi.fn());
vi.mock('../services/camera-frame.js', async (importOriginal) => ({
  ...(await importOriginal()),
  captureCameraFrame,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

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

  it('waits for the Android permission result before continuing', async () => {
    let granted = false;
    const bridge = {
      hasCameraPermission: vi.fn(() => granted),
      requestCameraPermission: vi.fn(() => {
        granted = true;
      }),
    };

    await expect(ensureAndroidCameraPermission(bridge, () => true, vi.fn())).resolves.toBe(true);
    expect(bridge.requestCameraPermission).toHaveBeenCalledOnce();
    expect(bridge.hasCameraPermission).toHaveBeenCalledTimes(2);
  });

  it('starts independently of model configuration and uses the selected lens', async () => {
    const { stream, track } = mediaStream();
    const getUserMedia = installMediaDevices(stream);
    const { result } = renderHook(() =>
      useCameraPreview('user', { ...DEFAULT_CAMERA_FRAME_SETTINGS }),
    );
    const video = document.createElement('video');
    const play = vi.spyOn(video, 'play').mockResolvedValue();
    result.current.videoRef.current = video;
    expect(getUserMedia).not.toHaveBeenCalled();

    await act(async () => result.current.start());
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: {
        facingMode: { ideal: 'user' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        aspectRatio: { ideal: 16 / 9 },
      },
    });
    expect(video.srcObject).toBe(stream);
    expect(play).toHaveBeenCalledOnce();

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(track.stop).toHaveBeenCalledOnce();
    expect(result.current.state).toBe('off');
  });

  it('invalidates pending control work synchronously when the camera track ends', async () => {
    const { stream, track } = mediaStream();
    installMediaDevices(stream);
    const onStopped = vi.fn();
    const { result } = renderHook(() =>
      useCameraPreview('environment', { ...DEFAULT_CAMERA_FRAME_SETTINGS }, onStopped),
    );
    const video = document.createElement('video');
    vi.spyOn(video, 'play').mockResolvedValue();
    result.current.videoRef.current = video;
    await act(async () => result.current.start());
    onStopped.mockClear();

    const ended = track.addEventListener.mock.calls.find(([type]) => type === 'ended')?.[1] as
      (() => void) | undefined;
    expect(ended).toBeTypeOf('function');
    act(() => ended?.());

    expect(onStopped).toHaveBeenCalledOnce();
    expect(result.current.state).toBe('off');
  });

  it('does not report a stale camera start after stop while video.play is pending', async () => {
    const { stream, track } = mediaStream();
    installMediaDevices(stream);
    const playing = deferred<void>();
    const { result } = renderHook(() =>
      useCameraPreview('environment', { ...DEFAULT_CAMERA_FRAME_SETTINGS }),
    );
    const video = document.createElement('video');
    vi.spyOn(video, 'play').mockReturnValue(playing.promise);
    result.current.videoRef.current = video;

    let starting!: Promise<void>;
    await act(async () => {
      starting = result.current.start();
      await Promise.resolve();
    });
    act(() => result.current.stop());
    playing.resolve();
    await act(async () => starting);

    expect(result.current.state).toBe('off');
    expect(video.srcObject).toBeNull();
    expect(track.stop).toHaveBeenCalled();
  });

  it('does not attach a permission listener after effect cleanup', async () => {
    const { stream } = mediaStream();
    installMediaDevices(stream);
    const permission = deferred<PermissionStatus>();
    const addEventListener = vi.fn();
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: { query: vi.fn(() => permission.promise) },
    });
    const { unmount } = renderHook(() =>
      useCameraPreview('environment', { ...DEFAULT_CAMERA_FRAME_SETTINGS }),
    );

    unmount();
    permission.resolve({ addEventListener } as unknown as PermissionStatus);
    await Promise.resolve();

    expect(addEventListener).not.toHaveBeenCalled();
  });

  it('drops a processed frame that finishes after the camera stops', async () => {
    const { stream } = mediaStream();
    installMediaDevices(stream);
    const { result } = renderHook(() =>
      useCameraPreview('environment', { ...DEFAULT_CAMERA_FRAME_SETTINGS }),
    );
    const video = document.createElement('video');
    vi.spyOn(video, 'play').mockResolvedValue();
    result.current.videoRef.current = video;
    await act(async () => result.current.start());

    let finish!: (value: unknown) => void;
    captureCameraFrame.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const pending = result.current.capture();
    act(() => result.current.stop());
    finish({
      image: { mediaType: 'image/webp', data: 'late', width: 768, height: 432, byteLength: 4 },
      previewBlob: new Blob(['late'], { type: 'image/webp' }),
    });

    await expect(pending).resolves.toBeUndefined();
  });

  it('stops active tracks when the module unmounts', async () => {
    const { stream, track } = mediaStream();
    installMediaDevices(stream);
    const { result, unmount } = renderHook(() =>
      useCameraPreview('environment', { ...DEFAULT_CAMERA_FRAME_SETTINGS }),
    );
    await act(async () => result.current.start());
    unmount();
    expect(track.stop).toHaveBeenCalledOnce();
  });
});
