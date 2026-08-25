import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
        onConnect={vi.fn()}
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
    expect(screen.queryByRole('heading', { name: '连接郊狼或负鼠' })).toBeNull();
    expect(screen.queryByRole('button', { name: '连接设备' })).toBeNull();
  });

  it('没有设备时只显示可操作的连接空状态，并提供清晰的安全说明', () => {
    const onConnect = vi.fn();
    render(
      <OutputDeviceSection
        targets={[]}
        selected={null}
        onSelect={vi.fn()}
        panelForTarget={vi.fn()}
        onConnect={onConnect}
        onAdjust={vi.fn()}
        onTogglePlay={vi.fn()}
        onStop={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: '连接郊狼或负鼠' })).toBeTruthy();
    expect(screen.getByText(/也可以使用页面顶部的「连接设备」/)).toBeTruthy();
    expect(screen.getByText(/连接不会自动产生输出/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /一键开火/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'A 通道波形' })).toBeNull();

    const connect = screen.getByRole('button', { name: '连接设备' });
    expect(connect.getAttribute('aria-describedby')).toBe('disconnected-output-safety');
    fireEvent.click(connect);
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it('连接期间暴露状态并以 alert 宣告连接错误', async () => {
    let rejectConnection: ((reason: Error) => void) | undefined;
    const onConnect = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectConnection = reject;
        }),
    );

    render(
      <OutputDeviceSection
        targets={[]}
        selected={null}
        onSelect={vi.fn()}
        panelForTarget={vi.fn()}
        onConnect={onConnect}
        onAdjust={vi.fn()}
        onTogglePlay={vi.fn()}
        onStop={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '连接设备' }));
    expect((screen.getByRole('button', { name: '连接中…' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    rejectConnection?.(new Error('蓝牙不可用'));
    expect((await screen.findByRole('alert')).textContent).toBe('蓝牙不可用');
    await waitFor(() =>
      expect((screen.getByRole('button', { name: '连接设备' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
  });
});
