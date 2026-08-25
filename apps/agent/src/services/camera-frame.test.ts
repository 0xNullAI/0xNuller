import { afterEach, describe, expect, it, vi } from 'vitest';
import { stopCameraStream } from '../hooks/use-camera-preview.js';
import {
  CAMERA_FRAME_MAX_BYTES,
  CAMERA_FRAME_MAX_EDGE,
  captureCameraFrame,
} from './camera-frame.js';

describe('camera frame contract', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('scales to 768px and never returns a payload over 250KB', async () => {
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: vi.fn() }),
      toBlob: (callback: BlobCallback, mediaType: string) =>
        callback(new Blob([new Uint8Array(128)], { type: mediaType })),
    } as unknown as HTMLCanvasElement;
    vi.stubGlobal('document', { createElement: () => canvas });
    const video = { videoWidth: 1920, videoHeight: 1080, readyState: 4 } as HTMLVideoElement;

    const frame = await captureCameraFrame(video);

    expect(Math.max(frame.width, frame.height)).toBe(CAMERA_FRAME_MAX_EDGE);
    expect(frame.byteLength).toBeLessThanOrEqual(CAMERA_FRAME_MAX_BYTES);
    expect(frame.mediaType).toBe('image/webp');
  });

  it('fails closed when every compressed candidate exceeds the hard limit', async () => {
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: vi.fn() }),
      toBlob: (callback: BlobCallback, mediaType: string) =>
        callback(new Blob([new Uint8Array(CAMERA_FRAME_MAX_BYTES + 1)], { type: mediaType })),
    } as unknown as HTMLCanvasElement;
    vi.stubGlobal('document', { createElement: () => canvas });

    await expect(
      captureCameraFrame({ videoWidth: 800, videoHeight: 600, readyState: 4 } as HTMLVideoElement),
    ).rejects.toThrow(/超过 250KB/);
  });

  it('stops every media track on lifecycle shutdown', () => {
    const first = { stop: vi.fn() };
    const second = { stop: vi.fn() };
    stopCameraStream({ getTracks: () => [first, second] } as unknown as MediaStream);
    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.stop).toHaveBeenCalledOnce();
  });
});
