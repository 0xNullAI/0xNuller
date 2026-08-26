// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  VideoSetupPanel,
  type VideoSetupPanelActions,
  type VideoSetupPanelViewModel,
} from './VideoSetupPanel.js';

const baseView: VideoSetupPanelViewModel = {
  scenes: [
    { id: 'gentle', name: '温柔陪伴', icon: '🌙' },
    { id: 'market-scene', name: '市场场景' },
  ],
  selectedSceneId: 'gentle',
  facingMode: 'environment',
  embeddedAvailable: true,
  showCoyoteConnect: true,
  coyoteConnectLabel: '添加郊狼',
  showOpossumConnect: true,
  targets: [
    {
      id: 'coyote/coyote-1',
      kind: 'coyote',
      label: '郊狼 · Alpha',
      battery: 80,
      active: false,
      modality: 'electrostimulation',
    },
    {
      id: 'opossum/opossum-1',
      kind: 'opossum',
      label: '负鼠 · Beta',
      battery: null,
      active: false,
      modality: 'vibration',
    },
  ],
  durationMinutes: 5,
  cadenceSeconds: 10,
  allowEnhanced: false,
  allowBurst: true,
  visionEnabled: true,
  error: null,
  ctaLabel: '开启',
  ctaDisabled: false,
};

function createActions(): VideoSetupPanelActions {
  return {
    openVideoSettings: vi.fn(),
    openSceneSettings: vi.fn(),
    selectScene: vi.fn(),
    setFacingMode: vi.fn(),
    connect: vi.fn(),
    discoverEmbeddedDevices: vi.fn(),
    setDurationMinutes: vi.fn(),
    setCadenceSeconds: vi.fn(),
    setAllowEnhanced: vi.fn(),
    setAllowBurst: vi.fn(),
    activate: vi.fn(),
  };
}

afterEach(cleanup);

describe('VideoSetupPanel', () => {
  it('renders the prepared DG-Lab fields and reports user input through typed actions', () => {
    const actions = createActions();
    render(<VideoSetupPanel view={baseView} actions={actions} />);

    expect(screen.getByRole('region', { name: 'Video 设置' })).toBeTruthy();
    expect(screen.getByRole('region', { name: '已连接输出能力' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: '输出设备' })).toBeNull();

    fireEvent.change(screen.getByRole('combobox', { name: '摄像头' }), {
      target: { value: 'user' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: '场景' }), {
      target: { value: 'market-scene' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: '允许增强' }));

    expect(actions.setFacingMode).toHaveBeenCalledWith('user');
    expect(actions.selectScene).toHaveBeenCalledWith('market-scene');
    expect(actions.setAllowEnhanced).toHaveBeenCalledWith(true);
  });

  it('shows an explicit empty selection instead of silently applying a background', () => {
    const actions = createActions();
    render(<VideoSetupPanel view={{ ...baseView, selectedSceneId: '' }} actions={actions} />);

    expect((screen.getByRole('combobox', { name: '场景' }) as HTMLSelectElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: '管理' }));
    expect(actions.openSceneSettings).toHaveBeenCalledOnce();
  });

  it('uses the parent-provided CTA state and exposes settings and errors accessibly', () => {
    const actions = createActions();
    render(
      <VideoSetupPanel
        view={{
          ...baseView,
          visionEnabled: false,
          ctaLabel: '预览摄像头',
          ctaDisabled: true,
          error: '摄像头权限被拒绝',
        }}
        actions={actions}
      />,
    );

    expect(screen.getByRole('button', { name: '预览摄像头' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('alert').textContent).toBe('摄像头权限被拒绝');
    expect(screen.getAllByRole('button', { name: /AI 设置|完成视觉模型设置/ })).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: '打开 AI 设置' }));
    expect(actions.openVideoSettings).toHaveBeenCalledOnce();
    expect(actions.activate).not.toHaveBeenCalled();
  });

  it('lists embedded capability read-only without requiring a human target selection', () => {
    const actions = createActions();
    render(
      <VideoSetupPanel
        view={{
          ...baseView,
          targets: [
            ...baseView.targets,
            {
              id: 'embedded/device/vibrate-1',
              kind: 'embedded',
              label: '通用设备 · Demo · 振动 1',
              battery: null,
              active: false,
              modality: 'vibration',
            },
          ],
        }}
        actions={actions}
      />,
    );

    expect(screen.getByText('通用设备 · Demo · 振动 1')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: '允许脉冲' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '查找通用设备' }));
    fireEvent.click(screen.getByRole('button', { name: '开启' }));
    expect(actions.discoverEmbeddedDevices).toHaveBeenCalledOnce();
    expect(actions.activate).toHaveBeenCalledOnce();
  });

  it('hides only the generic-device entry when the shared experiment is disabled', () => {
    const actions = createActions();
    render(
      <VideoSetupPanel
        view={{
          ...baseView,
          embeddedAvailable: false,
        }}
        actions={actions}
      />,
    );

    expect(screen.queryByRole('button', { name: '查找通用设备' })).toBeNull();
    expect(screen.getByRole('button', { name: '添加郊狼' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '连接负鼠' })).toBeTruthy();
  });
});
