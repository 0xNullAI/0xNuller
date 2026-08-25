import { afterEach, describe, expect, it, vi } from 'vitest';
import { stopCameraStream } from '../hooks/use-camera-preview.js';
import {
  CAMERA_FRAME_MAX_BYTES,
  CAMERA_FRAME_MAX_EDGE,
  DEFAULT_CAMERA_FRAME_SETTINGS,
  captureCameraFrame,
  computeCropRect,
  computeOutputSize,
} from './camera-frame.js';

function installCanvas(blobSize = 128) {
  const contexts: Array<Record<string, ReturnType<typeof vi.fn>>> = [];
  const canvases: HTMLCanvasElement[] = [];
  vi.stubGlobal('document', {
    createElement: () => {
      const context = {
        save: vi.fn(),
        translate: vi.fn(),
        rotate: vi.fn(),
        scale: vi.fn(),
        drawImage: vi.fn(),
        restore: vi.fn(),
        getImageData: vi.fn(),
        putImageData: vi.fn(),
      };
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => context,
        toBlob: (callback: BlobCallback, mediaType: string) =>
          callback(new Blob([new Uint8Array(blobSize)], { type: mediaType })),
      } as unknown as HTMLCanvasElement;
      contexts.push(context);
      canvases.push(canvas);
      return canvas;
    },
  });
  return { contexts, canvases };
}

const readyVideo = {
  videoWidth: 1920,
  videoHeight: 1080,
  readyState: 4,
} as HTMLVideoElement;

describe('camera frame geometry', () => {
  it('fits crop presets around a clamped center', () => {
    expect(computeCropRect(800, 600, '16:9', 0.5, 0)).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 450,
    });
    expect(computeCropRect(800, 600, '16:9', 0.5, 2)).toEqual({
      x: 0,
      y: 150,
      width: 800,
      height: 450,
    });
    expect(computeCropRect(1920, 1080, '1:1', -1, 0.5)).toEqual({
      x: 0,
      y: 0,
      width: 1080,
      height: 1080,
    });
  });

  it('swaps dimensions for quarter turns and bounds the selected output edge', () => {
    expect(computeOutputSize({ width: 800, height: 600 }, 0, 512)).toEqual({
      width: 512,
      height: 384,
    });
    expect(computeOutputSize({ width: 800, height: 600 }, 90, 512)).toEqual({
      width: 384,
      height: 512,
    });
    expect(computeOutputSize({ width: 2000, height: 1000 }, 0, 10_000).width).toBe(
      CAMERA_FRAME_MAX_EDGE,
    );
  });
});

describe('camera frame pipeline', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('scales to 768px and returns preview and model input from the same bounded blob', async () => {
    installCanvas();

    const frame = await captureCameraFrame(readyVideo);

    expect(Math.max(frame.image.width, frame.image.height)).toBe(CAMERA_FRAME_MAX_EDGE);
    expect(frame.image.byteLength).toBe(frame.previewBlob.size);
    expect(frame.image.byteLength).toBeLessThanOrEqual(CAMERA_FRAME_MAX_BYTES);
    expect(frame.image.mediaType).toBe(frame.previewBlob.type);
  });

  it('applies crop, rotation, and mirror before compression', async () => {
    const { contexts } = installCanvas();
    await captureCameraFrame(readyVideo, {
      ...DEFAULT_CAMERA_FRAME_SETTINGS,
      cropPreset: '1:1',
      cropCenterX: 1,
      rotation: 90,
      mirror: true,
      outputMaxEdge: 512,
    });

    const transform = contexts[0]!;
    expect(transform.rotate).toHaveBeenCalledWith(Math.PI / 2);
    expect(transform.scale).toHaveBeenCalledWith(-1, 1);
    expect(transform.drawImage).toHaveBeenCalledWith(
      readyVideo,
      840,
      0,
      1080,
      1080,
      -256,
      -256,
      512,
      512,
    );
  });

  it('fails closed when every compressed candidate exceeds the hard limit', async () => {
    installCanvas(CAMERA_FRAME_MAX_BYTES + 1);

    await expect(captureCameraFrame(readyVideo)).rejects.toThrow(/超过 250KB/);
  });

  it('stops every media track on lifecycle shutdown', () => {
    const first = { stop: vi.fn() };
    const second = { stop: vi.fn() };
    stopCameraStream({ getTracks: () => [first, second] } as unknown as MediaStream);
    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.stop).toHaveBeenCalledOnce();
  });
});
