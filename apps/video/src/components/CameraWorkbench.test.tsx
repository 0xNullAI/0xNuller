// @vitest-environment jsdom
import { createRef, useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CAMERA_FRAME_SETTINGS,
  type CameraFrameSettings,
} from '../services/camera-frame.js';
import { CameraWorkbench, pointerToCropCenter } from './CameraWorkbench.js';

function Harness() {
  const [settings, setSettings] = useState<CameraFrameSettings>({
    ...DEFAULT_CAMERA_FRAME_SETTINGS,
  });
  return (
    <CameraWorkbench
      videoRef={createRef<HTMLVideoElement>()}
      processedPreviewRef={createRef<HTMLImageElement>()}
      cameraState="on"
      visionEnabled
      facingMode="environment"
      settings={settings}
      latestFrame={null}
      onFacingModeChange={vi.fn()}
      onSettingsChange={setSettings}
      onStartCamera={vi.fn()}
      onStopCamera={vi.fn()}
      onCapture={vi.fn()}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('CameraWorkbench accessibility', () => {
  it('exposes named previews, controls, and native pointer/keyboard crop sliders', () => {
    render(<Harness />);

    expect(screen.getByLabelText('原始摄像头预览')).toBeTruthy();
    expect(screen.getByAltText('处理后的模型输入预览')).toBeTruthy();
    expect((screen.getByLabelText('横向裁剪中心') as HTMLInputElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('裁剪'), { target: { value: '1:1' } });
    const horizontal = screen.getByLabelText('横向裁剪中心');
    expect((horizontal as HTMLInputElement).disabled).toBe(false);
    fireEvent.change(horizontal, { target: { value: '75' } });
    expect((horizontal as HTMLInputElement).value).toBe('75');

    const cropCenter = screen.getByRole('button', { name: '移动裁剪中心' });
    fireEvent.keyDown(cropCenter, { key: 'ArrowLeft' });
    expect((horizontal as HTMLInputElement).value).toBe('74');

    expect((screen.getByRole('button', { name: '恢复默认' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect((screen.getByLabelText('亮度') as HTMLInputElement).type).toBe('range');
  });

  it('maps pointer positions to the displayed source area and clamps letterbox edges', () => {
    expect(
      pointerToCropCenter(50, 50, { left: 0, top: 0, width: 100, height: 100 }, 200, 100),
    ).toEqual([0.5, 0.5]);
    expect(
      pointerToCropCenter(0, 0, { left: 0, top: 0, width: 100, height: 100 }, 200, 100),
    ).toEqual([0, 0]);
  });

  it('keeps frame controls session-only and restores defaults after remount', () => {
    const persist = vi.spyOn(Storage.prototype, 'setItem');
    const first = render(<Harness />);
    fireEvent.change(screen.getByLabelText('亮度'), { target: { value: '25' } });
    expect((screen.getByLabelText('亮度') as HTMLInputElement).value).toBe('25');
    expect(persist).not.toHaveBeenCalled();

    first.unmount();
    render(<Harness />);
    expect((screen.getByLabelText('亮度') as HTMLInputElement).value).toBe('0');
    expect(persist).not.toHaveBeenCalled();
  });
});
