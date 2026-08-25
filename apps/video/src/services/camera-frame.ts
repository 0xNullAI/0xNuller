import type { LlmImageInput, LlmImageMediaType } from '@dg-agent/core';

export const CAMERA_FRAME_MAX_EDGE = 768;
export const CAMERA_FRAME_MAX_BYTES = 250 * 1024;

const SCALES = [1, 0.85, 0.7, 0.55] as const;
const QUALITIES = [0.82, 0.68, 0.54, 0.4] as const;
const MEDIA_TYPES: LlmImageMediaType[] = ['image/webp', 'image/jpeg'];

export type CameraCropPreset = 'original' | '16:9' | '4:3' | '1:1';
export type CameraRotation = -90 | 0 | 90;

export interface CameraFrameSettings {
  mirror: boolean;
  rotation: CameraRotation;
  brightness: number;
  contrast: number;
  shadows: number;
  highlights: number;
  sharpen: number;
  cropPreset: CameraCropPreset;
  cropCenterX: number;
  cropCenterY: number;
  outputMaxEdge: number;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FrameSize {
  width: number;
  height: number;
}

export interface CapturedCameraFrame {
  image: LlmImageInput;
  previewBlob: Blob;
}

export const DEFAULT_CAMERA_FRAME_SETTINGS: Readonly<CameraFrameSettings> = Object.freeze({
  mirror: false,
  rotation: 0,
  brightness: 0,
  contrast: 0,
  shadows: 0,
  highlights: 0,
  sharpen: 0,
  cropPreset: 'original',
  cropCenterX: 0.5,
  cropCenterY: 0.5,
  outputMaxEdge: CAMERA_FRAME_MAX_EDGE,
});

const CROP_ASPECTS: Record<Exclude<CameraCropPreset, 'original'>, number> = {
  '16:9': 16 / 9,
  '4:3': 4 / 3,
  '1:1': 1,
};

export function computeCropRect(
  sourceWidth: number,
  sourceHeight: number,
  preset: CameraCropPreset,
  centerX: number,
  centerY: number,
): CropRect {
  const width = Math.max(1, sourceWidth);
  const height = Math.max(1, sourceHeight);
  if (preset === 'original') return { x: 0, y: 0, width, height };

  const targetAspect = CROP_ASPECTS[preset];
  const sourceAspect = width / height;
  const cropWidth = sourceAspect > targetAspect ? height * targetAspect : width;
  const cropHeight = sourceAspect > targetAspect ? height : width / targetAspect;
  const desiredX = clamp(centerX, 0, 1) * width - cropWidth / 2;
  const desiredY = clamp(centerY, 0, 1) * height - cropHeight / 2;

  return {
    x: clamp(desiredX, 0, width - cropWidth),
    y: clamp(desiredY, 0, height - cropHeight),
    width: cropWidth,
    height: cropHeight,
  };
}

export function computeOutputSize(
  crop: Pick<CropRect, 'width' | 'height'>,
  rotation: CameraRotation,
  maxEdge: number,
): FrameSize {
  const orientedWidth = rotation === 0 ? crop.width : crop.height;
  const orientedHeight = rotation === 0 ? crop.height : crop.width;
  const boundedMaxEdge = clamp(Math.round(maxEdge), 1, CAMERA_FRAME_MAX_EDGE);
  const scale = Math.min(1, boundedMaxEdge / Math.max(orientedWidth, orientedHeight));
  return {
    width: Math.max(1, Math.round(orientedWidth * scale)),
    height: Math.max(1, Math.round(orientedHeight * scale)),
  };
}

/**
 * Build one transient model frame through source → crop → transform → adjust → compress.
 * The preview blob and model payload are encoded from the same compressed candidate.
 */
export async function captureCameraFrame(
  video: HTMLVideoElement,
  settings: CameraFrameSettings = { ...DEFAULT_CAMERA_FRAME_SETTINGS },
): Promise<CapturedCameraFrame> {
  if (video.videoWidth <= 0 || video.videoHeight <= 0 || video.readyState < 2) {
    throw new Error('摄像头画面尚未就绪，请稍后重试');
  }

  const normalized = normalizeSettings(settings);
  const crop = computeCropRect(
    video.videoWidth,
    video.videoHeight,
    normalized.cropPreset,
    normalized.cropCenterX,
    normalized.cropCenterY,
  );
  const outputSize = computeOutputSize(crop, normalized.rotation, normalized.outputMaxEdge);
  const processedCanvas = createCanvas(outputSize);
  const context = getContext(processedCanvas);

  drawTransformedSource(context, video, crop, outputSize, normalized);
  applyPixelAdjustments(context, outputSize, normalized);

  const compressed = await compressCanvas(processedCanvas);
  return {
    image: {
      mediaType: compressed.type as LlmImageMediaType,
      data: await blobToBase64(compressed.blob),
      width: compressed.width,
      height: compressed.height,
      byteLength: compressed.blob.size,
    },
    previewBlob: compressed.blob,
  };
}

function normalizeSettings(settings: CameraFrameSettings): CameraFrameSettings {
  return {
    mirror: settings.mirror === true,
    rotation: settings.rotation === -90 || settings.rotation === 90 ? settings.rotation : 0,
    brightness: clamp(settings.brightness, -50, 50),
    contrast: clamp(settings.contrast, -50, 50),
    shadows: clamp(settings.shadows, -50, 50),
    highlights: clamp(settings.highlights, -50, 50),
    sharpen: clamp(settings.sharpen, 0, 50),
    cropPreset:
      settings.cropPreset === 'original' || Object.hasOwn(CROP_ASPECTS, settings.cropPreset)
        ? settings.cropPreset
        : 'original',
    cropCenterX: clamp(settings.cropCenterX, 0, 1),
    cropCenterY: clamp(settings.cropCenterY, 0, 1),
    outputMaxEdge: clamp(settings.outputMaxEdge, 1, CAMERA_FRAME_MAX_EDGE),
  };
}

function drawTransformedSource(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  crop: CropRect,
  output: FrameSize,
  settings: CameraFrameSettings,
): void {
  const quarterTurn = settings.rotation !== 0;
  const drawWidth = quarterTurn ? output.height : output.width;
  const drawHeight = quarterTurn ? output.width : output.height;

  context.save();
  context.translate(output.width / 2, output.height / 2);
  context.rotate((settings.rotation * Math.PI) / 180);
  context.scale(settings.mirror ? -1 : 1, 1);
  context.drawImage(
    video,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    -drawWidth / 2,
    -drawHeight / 2,
    drawWidth,
    drawHeight,
  );
  context.restore();
}

function applyPixelAdjustments(
  context: CanvasRenderingContext2D,
  size: FrameSize,
  settings: CameraFrameSettings,
): void {
  const needsToneAdjustment =
    settings.brightness !== 0 ||
    settings.contrast !== 0 ||
    settings.shadows !== 0 ||
    settings.highlights !== 0;
  if (!needsToneAdjustment && settings.sharpen === 0) return;

  const image = context.getImageData(0, 0, size.width, size.height);
  if (needsToneAdjustment) adjustTone(image.data, settings);
  if (settings.sharpen > 0) sharpenPixels(image.data, size.width, size.height, settings.sharpen);
  context.putImageData(image, 0, 0);
}

export function adjustTone(
  pixels: Uint8ClampedArray,
  settings: Pick<CameraFrameSettings, 'brightness' | 'contrast' | 'shadows' | 'highlights'>,
): void {
  const brightnessOffset = clamp(settings.brightness, -50, 50) * 2.55;
  const contrastValue = clamp(settings.contrast, -50, 50) * 2.54;
  const contrastFactor = (259 * (contrastValue + 255)) / (255 * Math.max(1, 259 - contrastValue));
  const shadowAmount = clamp(settings.shadows, -50, 50) * 1.8;
  const highlightAmount = clamp(settings.highlights, -50, 50) * 1.8;

  for (let offset = 0; offset < pixels.length; offset += 4) {
    const luminance =
      (pixels[offset]! * 0.2126 + pixels[offset + 1]! * 0.7152 + pixels[offset + 2]! * 0.0722) /
      255;
    const localOffset = shadowAmount * (1 - luminance) ** 2 + highlightAmount * luminance ** 2;
    for (let channel = 0; channel < 3; channel += 1) {
      const contrasted = contrastFactor * (pixels[offset + channel]! - 128) + 128;
      pixels[offset + channel] = contrasted + brightnessOffset + localOffset;
    }
  }
}

export function sharpenPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  sharpen: number,
): void {
  if (width < 3 || height < 3 || sharpen <= 0) return;
  const source = new Uint8ClampedArray(pixels);
  const amount = clamp(sharpen, 0, 50) / 150;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const offset = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const neighbors =
          source[offset - width * 4 + channel]! +
          source[offset + width * 4 + channel]! +
          source[offset - 4 + channel]! +
          source[offset + 4 + channel]!;
        pixels[offset + channel] =
          source[offset + channel]! * (1 + 4 * amount) - neighbors * amount;
      }
    }
  }
}

async function compressCanvas(
  processedCanvas: HTMLCanvasElement,
): Promise<{ blob: Blob; type: string; width: number; height: number }> {
  const compressionCanvas = createCanvas({
    width: processedCanvas.width,
    height: processedCanvas.height,
  });
  const context = getContext(compressionCanvas);

  for (const scale of SCALES) {
    compressionCanvas.width = Math.max(1, Math.round(processedCanvas.width * scale));
    compressionCanvas.height = Math.max(1, Math.round(processedCanvas.height * scale));
    context.drawImage(processedCanvas, 0, 0, compressionCanvas.width, compressionCanvas.height);

    for (const mediaType of MEDIA_TYPES) {
      for (const quality of QUALITIES) {
        const blob = await canvasToBlob(compressionCanvas, mediaType, quality);
        if (blob.type !== mediaType || blob.size > CAMERA_FRAME_MAX_BYTES) continue;
        return {
          blob,
          type: mediaType,
          width: compressionCanvas.width,
          height: compressionCanvas.height,
        };
      }
    }
  }

  throw new Error('摄像头画面压缩后仍超过 250KB，请降低画面复杂度后重试');
}

function createCanvas(size: FrameSize): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  return canvas;
}

function getContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('当前环境无法处理摄像头画面');
  return context;
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
  if (typeof blob.arrayBuffer !== 'function') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('摄像头画面读取失败'));
      reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '');
      reader.readAsDataURL(blob);
    });
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function clamp(value: number, minimum: number, maximum: number): number {
  const normalized = Number.isFinite(value) ? value : minimum;
  return Math.min(maximum, Math.max(minimum, normalized));
}
