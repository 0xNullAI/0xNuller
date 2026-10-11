import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CoyoteSummary } from '@0xnullai/device-runtime';
import {
  OutputDeviceSection,
  type OutputPanelState,
  type OutputTarget,
} from './OutputDeviceSection';

const coyote: CoyoteSummary = {
  id: 'host-a',
  name: '郊狼',
  version: 'v3',
  connected: true,
  battery: 82,
  strengthA: 4,
  strengthB: 0,
  limitA: 30,
  limitB: 30,
  waveActiveA: false,
  waveActiveB: false,
  waveIdA: null,
  waveIdB: null,
};

function panel(): OutputPanelState {
  return {
    waveTab: 'A',
    onWaveTabChange: vi.fn(),
    waveforms: [],
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
    fireLimitA: 30,
    fireLimitB: 30,
    firingA: false,
    firingB: false,
    onFireStart: vi.fn(),
    onFireStop: vi.fn(),
  };
}

describe('设备页', () => {
  it('无输出设备时保留连接入口', () => {
    const onConnect = vi.fn();
    render(
      <OutputDeviceSection
        targets={[]}
        selected={null}
        onSelect={vi.fn()}
        panelForTarget={panel}
        onConnect={onConnect}
        onAdjust={vi.fn()}
        onTogglePlay={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: '尚未连接设备' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '连接设备' }));
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it('已连接时将输出与波形放在同一设备页并可选择物理目标', () => {
    const targets: OutputTarget[] = [
      { id: 'coyote:host-a', kind: 'coyote', label: '郊狼 1', coyote },
      {
        id: 'coyote:host-b',
        kind: 'coyote',
        label: '郊狼 2',
        coyote: { ...coyote, id: 'host-b', strengthA: 0 },
      },
    ];
    const onSelect = vi.fn();
    render(
      <OutputDeviceSection
        targets={targets}
        selected={targets[0] ?? null}
        onSelect={onSelect}
        panelForTarget={panel}
        onConnect={vi.fn()}
        onAdjust={vi.fn()}
        onTogglePlay={vi.fn()}
      />,
    );

    expect(screen.getByRole('combobox', { name: '当前设备' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '波形' })).toBeTruthy();
    expect(screen.getByText('A 4 · B 0')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: '当前设备' }), {
      target: { value: 'coyote:host-b' },
    });
    expect(onSelect).toHaveBeenCalledWith('coyote:host-b');
  });

  it('只有一台输出设备时直接显示控制，不重复显示设备选择器', () => {
    const target: OutputTarget = { id: 'coyote:host-a', kind: 'coyote', label: '郊狼', coyote };
    render(
      <OutputDeviceSection
        targets={[target]}
        selected={target}
        onSelect={vi.fn()}
        panelForTarget={panel}
        onConnect={vi.fn()}
        onAdjust={vi.fn()}
        onTogglePlay={vi.fn()}
      />,
    );

    expect(screen.queryByRole('combobox', { name: '当前设备' })).toBeNull();
    expect(screen.getByRole('heading', { name: '波形' })).toBeTruthy();
    expect(screen.getByText('A 4 · B 0')).toBeTruthy();
  });

  it('外部切换选中目标时只滚动设备卡，不让旧设备卡与当前控制台错位', () => {
    const targets: OutputTarget[] = [
      { id: 'coyote:host-a', kind: 'coyote', label: '郊狼 1', coyote },
      { id: 'coyote:host-b', kind: 'coyote', label: '郊狼 2', coyote: { ...coyote, id: 'host-b' } },
    ];
    const props = {
      targets,
      onSelect: vi.fn(),
      panelForTarget: panel,
      onConnect: vi.fn(),
      onAdjust: vi.fn(),
      onTogglePlay: vi.fn(),
    };
    const view = render(<OutputDeviceSection {...props} selected={targets[0] ?? null} />);
    const carousel = screen.getByLabelText('选择输出设备') as HTMLDivElement;
    const second = carousel.querySelector<HTMLElement>('[data-output-id="coyote:host-b"]')!;
    carousel.getBoundingClientRect = vi.fn(() => ({ left: 0, width: 300 }) as DOMRect);
    second.getBoundingClientRect = vi.fn(() => ({ left: 300, width: 300 }) as DOMRect);

    view.rerender(<OutputDeviceSection {...props} selected={targets[1] ?? null} />);

    expect(carousel.scrollLeft).toBe(300);
    expect((screen.getByRole('combobox', { name: '当前设备' }) as HTMLSelectElement).value).toBe(
      'coyote:host-b',
    );
    expect(props.onSelect).not.toHaveBeenCalled();
  });
});
