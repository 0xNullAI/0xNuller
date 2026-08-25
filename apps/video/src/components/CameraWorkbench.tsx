import {
  useId,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { Camera, CameraOff, ScanEye } from 'lucide-react';
import { Button } from '@0xnullai/ui';
import type { FrameMetadata } from '../services/visual-session.js';
import {
  DEFAULT_CAMERA_FRAME_SETTINGS,
  type CameraCropPreset,
  type CameraFrameSettings,
  type CameraRotation,
} from '../services/camera-frame.js';
import type { CameraFacingMode, CameraPreviewState } from '../hooks/use-camera-preview.js';

interface CameraWorkbenchProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  processedPreviewRef: RefObject<HTMLImageElement | null>;
  cameraState: CameraPreviewState;
  visionEnabled: boolean;
  facingMode: CameraFacingMode;
  settings: CameraFrameSettings;
  latestFrame: FrameMetadata | null;
  onFacingModeChange(mode: CameraFacingMode): void;
  onSettingsChange(settings: CameraFrameSettings): void;
  onStartCamera(): void;
  onStopCamera(): void;
  onCapture(): void;
}

export function CameraWorkbench({
  videoRef,
  processedPreviewRef,
  cameraState,
  visionEnabled,
  facingMode,
  settings,
  latestFrame,
  onFacingModeChange,
  onSettingsChange,
  onStartCamera,
  onStopCamera,
  onCapture,
}: CameraWorkbenchProps) {
  const update = (patch: Partial<CameraFrameSettings>) =>
    onSettingsChange({ ...settings, ...patch });
  const cropPositionDisabled = settings.cropPreset === 'original';

  return (
    <section className="flex min-h-[520px] flex-col overflow-hidden rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--bg-strong)]">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--surface-border)] px-4 py-3">
        <div>
          <h1 className="font-semibold">Video</h1>
          <p className="text-xs text-[var(--text-faint)]">画面工作台</p>
        </div>
        <label className="flex items-center gap-2 text-xs text-[var(--text-soft)]">
          摄像头
          <select
            value={facingMode}
            onChange={(event) => onFacingModeChange(event.target.value as CameraFacingMode)}
            className="rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-2 py-1.5"
          >
            <option value="environment">后置</option>
            <option value="user">前置</option>
          </select>
        </label>
      </header>

      <div className="grid min-h-[260px] gap-px bg-[var(--surface-border)] sm:grid-cols-2">
        <PreviewPanel label="原始画面">
          <video
            ref={videoRef}
            muted
            playsInline
            aria-label="原始摄像头预览"
            className="h-full min-h-[240px] w-full object-contain"
          />
          {settings.cropPreset !== 'original' && (
            <CropCenterOverlay
              videoRef={videoRef}
              centerX={settings.cropCenterX}
              centerY={settings.cropCenterY}
              onChange={(cropCenterX, cropCenterY) => update({ cropCenterX, cropCenterY })}
            />
          )}
          {cameraState !== 'on' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/75 px-6 text-center text-white">
              <Camera className="h-8 w-8 opacity-75" aria-hidden />
              <p className="text-sm">
                {cameraState === 'starting' ? '正在启动摄像头…' : '摄像头已关闭'}
              </p>
              <Button
                onClick={onStartCamera}
                disabled={!visionEnabled || cameraState === 'starting'}
              >
                开启摄像头
              </Button>
            </div>
          )}
        </PreviewPanel>
        <PreviewPanel label="模型输入">
          <div className="absolute inset-0 flex items-center justify-center text-xs text-white/50">
            处理后的画面显示于此
          </div>
          <img
            ref={processedPreviewRef}
            alt="处理后的模型输入预览"
            className="relative h-full min-h-[240px] w-full object-contain"
          />
        </PreviewPanel>
      </div>

      <fieldset className="relative grid gap-3 border-t border-[var(--surface-border)] p-4">
        <legend className="text-xs font-medium">画面处理</legend>
        <button
          type="button"
          onClick={() => onSettingsChange({ ...DEFAULT_CAMERA_FRAME_SETTINGS })}
          className="absolute right-4 top-4 text-xs text-[var(--accent-strong)] hover:underline"
        >
          恢复默认
        </button>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <SelectControl
            label="裁剪"
            value={settings.cropPreset}
            onChange={(value) => update({ cropPreset: value as CameraCropPreset })}
            options={[
              ['original', '原始比例'],
              ['16:9', '16:9'],
              ['4:3', '4:3'],
              ['1:1', '1:1'],
            ]}
          />
          <SelectControl
            label="旋转"
            value={String(settings.rotation)}
            onChange={(value) => update({ rotation: Number(value) as CameraRotation })}
            options={[
              ['0', '0°'],
              ['-90', '-90°'],
              ['90', '+90°'],
            ]}
          />
          <SelectControl
            label="输出尺寸"
            value={String(settings.outputMaxEdge)}
            onChange={(value) => update({ outputMaxEdge: Number(value) })}
            options={[
              ['384', '384 px'],
              ['512', '512 px'],
              ['768', '768 px'],
            ]}
          />
          <label className="flex items-center gap-2 self-end rounded-[var(--radius-ctl)] border border-[var(--surface-border)] px-2 py-2 text-xs text-[var(--text-soft)]">
            <input
              type="checkbox"
              checked={settings.mirror}
              onChange={(event) => update({ mirror: event.target.checked })}
            />
            镜像
          </label>
        </div>

        <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
          <RangeControl
            label="横向裁剪中心"
            value={Math.round(settings.cropCenterX * 100)}
            disabled={cropPositionDisabled}
            onChange={(value) => update({ cropCenterX: value / 100 })}
          />
          <RangeControl
            label="纵向裁剪中心"
            value={Math.round(settings.cropCenterY * 100)}
            disabled={cropPositionDisabled}
            onChange={(value) => update({ cropCenterY: value / 100 })}
          />
          <RangeControl
            label="亮度"
            value={settings.brightness}
            min={-50}
            max={50}
            onChange={(brightness) => update({ brightness })}
          />
          <RangeControl
            label="对比度"
            value={settings.contrast}
            min={-50}
            max={50}
            onChange={(contrast) => update({ contrast })}
          />
          <RangeControl
            label="阴影"
            value={settings.shadows}
            min={-50}
            max={50}
            onChange={(shadows) => update({ shadows })}
          />
          <RangeControl
            label="高光"
            value={settings.highlights}
            min={-50}
            max={50}
            onChange={(highlights) => update({ highlights })}
          />
          <RangeControl
            label="锐化"
            value={settings.sharpen}
            min={0}
            max={50}
            onChange={(sharpen) => update({ sharpen })}
          />
        </div>
      </fieldset>

      <footer className="flex flex-wrap items-center gap-2 border-t border-[var(--surface-border)] p-3">
        {cameraState === 'on' && (
          <Button variant="secondary" onClick={onStopCamera}>
            <CameraOff className="h-4 w-4" /> 关闭
          </Button>
        )}
        <Button variant="secondary" onClick={onCapture} disabled={cameraState !== 'on'}>
          <ScanEye className="h-4 w-4" /> 采集
        </Button>
        <span className="ml-auto text-xs text-[var(--text-faint)]">
          {latestFrame
            ? `${latestFrame.width}×${latestFrame.height} · ${Math.ceil(latestFrame.byteLength / 1024)}KB`
            : '尚无处理画面'}
        </span>
      </footer>
    </section>
  );
}

interface DisplayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function pointerToCropCenter(
  clientX: number,
  clientY: number,
  bounds: DisplayRect,
  sourceWidth: number,
  sourceHeight: number,
): [number, number] {
  const safeWidth = Math.max(1, bounds.width);
  const safeHeight = Math.max(1, bounds.height);
  const width = Math.max(1, sourceWidth);
  const height = Math.max(1, sourceHeight);
  const scale = Math.min(safeWidth / width, safeHeight / height);
  const displayedWidth = width * scale;
  const displayedHeight = height * scale;
  const offsetX = (safeWidth - displayedWidth) / 2;
  const offsetY = (safeHeight - displayedHeight) / 2;
  return [
    clamp01((clientX - bounds.left - offsetX) / displayedWidth),
    clamp01((clientY - bounds.top - offsetY) / displayedHeight),
  ];
}

function CropCenterOverlay({
  videoRef,
  centerX,
  centerY,
  onChange,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  centerX: number;
  centerY: number;
  onChange(centerX: number, centerY: number): void;
}) {
  const moveFromPointer = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const video = videoRef.current;
    if (!video) return;
    const [nextX, nextY] = pointerToCropCenter(
      event.clientX,
      event.clientY,
      video.getBoundingClientRect(),
      video.videoWidth,
      video.videoHeight,
    );
    onChange(nextX, nextY);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 0.05 : 0.01;
    let nextX = centerX;
    let nextY = centerY;
    if (event.key === 'ArrowLeft') nextX -= step;
    else if (event.key === 'ArrowRight') nextX += step;
    else if (event.key === 'ArrowUp') nextY -= step;
    else if (event.key === 'ArrowDown') nextY += step;
    else return;
    event.preventDefault();
    onChange(clamp01(nextX), clamp01(nextY));
  };

  return (
    <button
      type="button"
      aria-label="移动裁剪中心"
      aria-description="拖动，或使用方向键移动；按住 Shift 可增大步长"
      className="absolute inset-0 cursor-crosshair touch-none"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        moveFromPointer(event);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) moveFromPointer(event);
      }}
      onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
      onPointerCancel={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
      onKeyDown={onKeyDown}
    >
      <span
        aria-hidden
        className="absolute h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-black/30 shadow"
        style={{ left: `${clamp01(centerX) * 100}%`, top: `${clamp01(centerY) * 100}%` }}
      />
    </button>
  );
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0.5));
}

function PreviewPanel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <figure className="relative min-h-[240px] overflow-hidden bg-black">
      <figcaption className="absolute left-2 top-2 z-[var(--z-local-popover)] rounded bg-black/60 px-2 py-1 text-xs text-white">
        {label}
      </figcaption>
      {children}
    </figure>
  );
}

function SelectControl({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange(value: string): void;
}) {
  return (
    <label className="grid gap-1 text-xs text-[var(--text-soft)]">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-2 py-2"
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </label>
  );
}

function RangeControl({
  label,
  value,
  onChange,
  min = 0,
  max = 100,
  disabled = false,
}: {
  label: string;
  value: number;
  onChange(value: number): void;
  min?: number;
  max?: number;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="grid grid-cols-[1fr_auto] gap-x-2 text-xs text-[var(--text-soft)]">
      <label htmlFor={id}>{label}</label>
      <output htmlFor={id}>{value}</output>
      <input
        id={id}
        className="col-span-2"
        type="range"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}
