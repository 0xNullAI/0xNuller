import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OutputDeviceSection, type OutputTarget } from './OutputDeviceSection';

const opossum: OutputTarget = {
  id: 'opossum',
  kind: 'opossum',
  label: '负鼠',
  limitA: 40,
  limitB: 60,
  opossum: {
    connected: true,
    deviceName: 'Opossum',
    battery: 80,
    intensityA: 7,
    intensityB: 9,
    limitA: 40,
    limitB: 60,
    waveIdA: 'breath',
    waveIdB: null,
    lastButtons: null,
    lastButtonsAt: null,
  },
};

describe('Control 统一输出控制台', () => {
  it('负鼠使用和郊狼一致的双通道、波形与开火结构，并且没有灯光颜色', () => {
    render(
      <OutputDeviceSection
        targets={[opossum]}
        selected={opossum}
        onSelect={vi.fn()}
        queueLengthA={1}
        queueLengthB={1}
        firingA={false}
        firingB={false}
        onAdjust={vi.fn()}
        onTogglePlay={vi.fn()}
        onFireStart={vi.fn()}
        onFireStop={vi.fn()}
        onStop={vi.fn()}
        onDisconnect={vi.fn()}
        waveTab="A"
        onWaveTabChange={vi.fn()}
        waveforms={[]}
        queue={['breath']}
        activeWaveId="breath"
        playMode="single"
        intervalSec={10}
        onPlayModeChange={vi.fn()}
        onIntervalChange={vi.fn()}
        onToggleWaveform={vi.fn()}
        onRemoveWaveform={vi.fn()}
        onImportFile={vi.fn(async () => null)}
        onOpenMarket={vi.fn()}
      />,
    );

    expect(screen.getByText('负鼠 控制台')).toBeTruthy();
    expect(screen.getByRole('button', { name: /一键开火/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'A 通道波形' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'B 通道波形' })).toBeTruthy();
    expect(screen.queryByText('灯光颜色')).toBeNull();
  });
});
