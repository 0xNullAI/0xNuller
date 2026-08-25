import type { RefObject } from 'react';
import { CameraOff } from 'lucide-react';
import { Button } from '@0xnullai/ui';
import type { FrameMetadata } from '../services/visual-session.js';
import type { CameraPreviewState } from '../hooks/use-camera-preview.js';

interface CameraWorkbenchProps {
  processedPreviewRef: RefObject<HTMLImageElement | null>;
  cameraState: CameraPreviewState;
  latestFrame: FrameMetadata | null;
  onStopCamera(): void;
}

/**
 * The active Video surface intentionally shows only the latest processed frame.
 * Source video and frame controls stay private implementation details.
 */
export function CameraWorkbench({
  processedPreviewRef,
  cameraState,
  latestFrame,
  onStopCamera,
}: CameraWorkbenchProps) {
  return (
    <section className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-black">
      <div className="relative aspect-video min-h-[240px] w-full overflow-hidden">
        <img ref={processedPreviewRef} alt="最新处理画面" className="h-full w-full object-cover" />
        {!latestFrame && (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-white/70">
            {cameraState === 'starting' ? '正在开启摄像头…' : '正在准备处理后的画面…'}
          </div>
        )}
        <div className="absolute inset-x-0 top-0 flex items-center justify-between bg-gradient-to-b from-black/70 to-transparent p-3">
          <div>
            <h1 className="text-sm font-semibold text-white">Video</h1>
            <p className="text-xs text-white/65">固定 16:9 · 处理后画面</p>
          </div>
          <Button size="sm" variant="secondary" onClick={onStopCamera}>
            <CameraOff className="h-4 w-4" /> 结束
          </Button>
        </div>
        {latestFrame && (
          <span className="absolute bottom-3 right-3 rounded bg-black/60 px-2 py-1 text-[11px] text-white/70">
            {latestFrame.width}×{latestFrame.height} · {Math.ceil(latestFrame.byteLength / 1024)}KB
          </span>
        )}
      </div>
    </section>
  );
}
