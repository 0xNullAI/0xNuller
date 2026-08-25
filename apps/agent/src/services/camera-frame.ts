import type { LlmImageInput, LlmImageMediaType } from '@dg-agent/core';

export const CAMERA_FRAME_MAX_EDGE = 768;
export const CAMERA_FRAME_MAX_BYTES = 250 * 1024;

const SCALES = [1, 0.85, 0.7, 0.55] as const;
const QUALITIES = [0.82, 0.68, 0.54, 0.4] as const;
const MEDIA_TYPES: LlmImageMediaType[] = ['image/webp', 'image/jpeg'];

/** Capture exactly one bounded, compressed frame from an already-active preview. */
export async function captureCameraFrame(video: HTMLVideoElement): Promise<LlmImageInput> {
  if (video.videoWidth <= 0 || video.videoHeight <= 0 || video.readyState < 2) {
    throw new Error('摄像头画面尚未就绪，请稍后重试');
  }

  const baseScale = Math.min(1, CAMERA_FRAME_MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('当前环境无法处理摄像头画面');

  for (const scale of SCALES) {
    canvas.width = Math.max(1, Math.round(video.videoWidth * baseScale * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * baseScale * scale));
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    for (const mediaType of MEDIA_TYPES) {
      for (const quality of QUALITIES) {
        const blob = await canvasToBlob(canvas, mediaType, quality);
        // Browsers that do not support WebP may silently return PNG. PNG is
        // intentionally rejected because this contract only permits JPEG/WebP.
        if (blob.type !== mediaType || blob.size > CAMERA_FRAME_MAX_BYTES) continue;
        return {
          mediaType,
          data: await blobToBase64(blob),
          width: canvas.width,
          height: canvas.height,
          byteLength: blob.size,
        };
      }
    }
  }

  throw new Error('摄像头画面压缩后仍超过 250KB，请降低画面复杂度后重试');
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mediaType: LlmImageMediaType,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('摄像头画面压缩失败'))),
      mediaType,
      quality,
    );
  });
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
