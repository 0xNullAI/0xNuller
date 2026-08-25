// @vitest-environment jsdom
import { createRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CameraWorkbench } from './CameraWorkbench.js';

function renderWorkbench(onStopCamera = vi.fn()) {
  render(
    <CameraWorkbench
      processedPreviewRef={createRef<HTMLImageElement>()}
      cameraState="on"
      latestFrame={{ width: 768, height: 432, byteLength: 12_000, capturedAt: 1 }}
      onStopCamera={onStopCamera}
    />,
  );
}

afterEach(cleanup);

describe('CameraWorkbench', () => {
  it('shows only the fixed processed model frame', () => {
    renderWorkbench();

    expect(screen.getByAltText('最新处理画面')).toBeTruthy();
    expect(screen.getByText('固定 16:9 · 处理后画面')).toBeTruthy();
    expect(screen.queryByText('原始画面')).toBeNull();
    expect(screen.queryByLabelText('裁剪')).toBeNull();
    expect(screen.queryByLabelText('亮度')).toBeNull();
    expect(screen.queryByRole('button', { name: '采集' })).toBeNull();
  });

  it('returns to setup through one end action', () => {
    const onStopCamera = vi.fn();
    renderWorkbench(onStopCamera);
    fireEvent.click(screen.getByRole('button', { name: '结束' }));
    expect(onStopCamera).toHaveBeenCalledOnce();
  });
});
