import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { WaveformPanel } from './CoyoteControl';

function renderPanel(overrides: Partial<ComponentProps<typeof WaveformPanel>> = {}) {
  const onFireStart = vi.fn();
  const onFireStop = vi.fn();
  render(
    <WaveformPanel
      targetName={null}
      waveTab="A"
      onWaveTabChange={vi.fn()}
      waveforms={[]}
      queue={[]}
      activeWaveId={null}
      playMode="single"
      intervalSec={10}
      onPlayModeChange={vi.fn()}
      onIntervalChange={vi.fn()}
      onToggleWaveform={vi.fn()}
      onRemoveWaveform={vi.fn()}
      onImportFile={vi.fn(async () => null)}
      onOpenMarket={vi.fn()}
      onStopAll={vi.fn()}
      fireEnabledA={false}
      fireEnabledB={false}
      fireLimitA={30}
      fireLimitB={30}
      firingA={false}
      firingB={false}
      onFireStart={onFireStart}
      onFireStop={onFireStop}
      {...overrides}
    />,
  );
  return { onFireStart, onFireStop };
}

describe('WaveformPanel 一键开火', () => {
  it('未启动波形时保持禁用并解释原因', () => {
    renderPanel();
    expect(screen.getByText('一键开火')).toBeTruthy();
    expect((screen.getByTitle('请先启动 A 通道波形') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTitle('请先启动 B 通道波形') as HTMLButtonElement).disabled).toBe(true);
  });

  it('按住启动并在触摸取消时立即恢复', () => {
    const { onFireStart, onFireStop } = renderPanel({ fireEnabledA: true });
    const button = screen.getByTitle('按住临时增加 A 通道强度');

    fireEvent.pointerDown(button, { pointerId: 1 });
    expect(onFireStart).toHaveBeenCalledWith('A', 5);

    fireEvent.pointerCancel(button, { pointerId: 1 });
    expect(onFireStop).toHaveBeenCalledWith('A');
  });
});
