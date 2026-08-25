// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  VideoSetupPanel,
  type VideoSetupPanelActions,
  type VideoSetupPanelViewModel,
} from './VideoSetupPanel.js';

const baseView: VideoSetupPanelViewModel = {
  facingMode: 'environment',
  targetFamily: 'dg-lab',
  embeddedAvailable: true,
  showCoyoteConnect: true,
  coyoteConnectLabel: '添加郊狼',
  showOpossumConnect: true,
  targetOptions: [
    { value: 'coyote-1', label: '郊狼 · Alpha' },
    { value: 'opossum-1', label: '负鼠 · Beta' },
  ],
  selectedTargetId: 'coyote-1',
  channel: 'B',
  embeddedFeatureOptions: [{ value: 'vibrate-1', label: 'Demo · 振动 1' }],
  selectedEmbeddedFeatureId: '',
  intensityLabel: '8/20',
  intensityMax: 20,
  intensityStep: 1,
  intensityValue: 8,
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
    setFacingMode: vi.fn(),
    setTargetFamily: vi.fn(),
    connect: vi.fn(),
    discoverEmbeddedDevices: vi.fn(),
    selectTarget: vi.fn(),
    selectEmbeddedFeature: vi.fn(),
    setChannel: vi.fn(),
    setIntensity: vi.fn(),
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
    expect(screen.getByRole('combobox', { name: '目标' })).toHaveProperty('value', 'coyote-1');
    expect(screen.getByRole('combobox', { name: '通道' })).toHaveProperty('value', 'B');
    expect(screen.getByRole('slider', { name: '强度上限 · 8/20' })).toHaveProperty('max', '20');

    fireEvent.change(screen.getByRole('combobox', { name: '摄像头' }), {
      target: { value: 'user' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: '目标' }), {
      target: { value: 'opossum-1' },
    });
    fireEvent.change(screen.getByRole('slider', { name: '强度上限 · 8/20' }), {
      target: { value: '6' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: '允许增强' }));

    expect(actions.setFacingMode).toHaveBeenCalledWith('user');
    expect(actions.selectTarget).toHaveBeenCalledWith('opossum-1');
    expect(actions.setIntensity).toHaveBeenCalledWith(6);
    expect(actions.setAllowEnhanced).toHaveBeenCalledWith(true);
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

  it('renders only the embedded target controls when the parent selects that family', () => {
    const actions = createActions();
    render(
      <VideoSetupPanel
        view={{
          ...baseView,
          targetFamily: 'embedded',
          selectedEmbeddedFeatureId: 'vibrate-1',
          intensityLabel: '20%',
          intensityMax: 1,
          intensityStep: 0.01,
          intensityValue: 0.2,
        }}
        actions={actions}
      />,
    );

    expect(screen.getByRole('combobox', { name: '振动功能' })).toHaveProperty('value', 'vibrate-1');
    expect(screen.queryByRole('combobox', { name: '目标' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: '允许脉冲' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '查找设备' }));
    fireEvent.click(screen.getByRole('button', { name: '开启' }));
    expect(actions.discoverEmbeddedDevices).toHaveBeenCalledOnce();
    expect(actions.activate).toHaveBeenCalledOnce();
  });
});
