import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  OutputDeviceSection,
  type OutputPanelState,
  type OutputTarget,
} from './OutputDeviceSection';

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
    const panel: OutputPanelState = {
      waveTab: 'A',
      onWaveTabChange: vi.fn(),
      waveforms: [],
      queue: ['breath'],
      queueA: ['breath'],
      queueB: [],
      activeWaveId: 'breath',
      playMode: 'single',
      intervalSec: 10,
      onPlayModeChange: vi.fn(),
      onIntervalChange: vi.fn(),
      onToggleWaveform: vi.fn(),
      onRemoveWaveform: vi.fn(),
      onImportFile: vi.fn(async () => null),
      onOpenMarket: vi.fn(),
      fireEnabledA: true,
      fireEnabledB: true,
      fireLimitA: 40,
      fireLimitB: 60,
      firingA: false,
      firingB: false,
      onFireStart: vi.fn(),
      onFireStop: vi.fn(),
    };

    render(
      <OutputDeviceSection
        targets={[opossum]}
        selected={opossum}
        onSelect={vi.fn()}
        panelForTarget={() => panel}
        emptyPanel={panel}
        onAdjust={vi.fn()}
        onTogglePlay={vi.fn()}
        onStop={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    );

    expect(screen.getAllByText('负鼠').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /一键开火/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'A 通道波形' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'B 通道波形' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: /通道节奏/ })).toBeNull();
    expect(screen.queryByText('灯光颜色')).toBeNull();
    expect(screen.queryByRole('button', { name: /归零/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /断开/ })).toBeNull();
  });

  it('没有设备时保留一台灰色郊狼完整控制台，所有输出操作禁用', () => {
    const panel: OutputPanelState = {
      waveTab: 'A',
      onWaveTabChange: vi.fn(),
      waveforms: [
        {
          id: 'breath',
          name: '呼吸',
          frames: [[10, 20]],
          modality: 'electrostimulation',
        },
      ],
      queue: [],
      queueA: [],
      queueB: [],
      activeWaveId: null,
      playMode: 'single',
      intervalSec: 10,
      onPlayModeChange: vi.fn(),
      onIntervalChange: vi.fn(),
      onToggleWaveform: vi.fn(),
      onRemoveWaveform: vi.fn(),
      onImportFile: vi.fn(async () => null),
      onOpenMarket: vi.fn(),
      fireEnabledA: false,
      fireEnabledB: false,
      fireLimitA: 0,
      fireLimitB: 0,
      firingA: false,
      firingB: false,
      onFireStart: vi.fn(),
      onFireStop: vi.fn(),
    };

    render(
      <OutputDeviceSection
        targets={[]}
        selected={null}
        onSelect={vi.fn()}
        panelForTarget={vi.fn()}
        emptyPanel={panel}
        onAdjust={vi.fn()}
        onTogglePlay={vi.fn()}
        onStop={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('未连接的郊狼控制台')).toBeTruthy();
    expect(screen.getByText('未连接 · 请从顶部连接设备')).toBeTruthy();
    expect(screen.getByText('呼吸').closest('[role="button"]')?.getAttribute('aria-disabled')).toBe(
      'true',
    );
    expect((screen.getByRole('button', { name: /一键开火/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
