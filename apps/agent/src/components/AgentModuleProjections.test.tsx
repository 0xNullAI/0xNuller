// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { DEFAULT_DEVICE_LINK_RULE } from '@dg-agent/core';
import { defaultBrowserAppSettings } from '@dg-agent/storage-browser';
import {
  AgentModuleProjections,
  type AgentModuleProjectionsProps,
} from './AgentModuleProjections.js';

vi.mock('@0xnullai/ui', () => ({
  ModuleActions: ({ children }: { children: ReactNode }) => (
    <div data-testid="module-actions">{children}</div>
  ),
  ModuleSettingsSection: ({
    id,
    label,
    children,
  }: {
    id: string;
    label: string;
    children: ReactNode;
  }) => (
    <section data-testid={id} aria-label={label}>
      {children}
    </section>
  ),
}));

vi.mock('./DebugPanel.js', () => ({
  DebugPanel: ({ onClose }: { onClose: () => void }) => (
    <div role="dialog" aria-label="调试面板">
      <button type="button" onClick={onClose}>
        关闭调试面板
      </button>
    </div>
  ),
}));

vi.mock('./settings/SensorsTab.js', () => ({
  SensorsTab: ({
    onToggleSensorTriggers,
  }: {
    onToggleSensorTriggers: (value: boolean) => void;
  }) => (
    <button type="button" onClick={() => onToggleSensorTriggers(true)}>
      启用传感器
    </button>
  ),
}));

vi.mock('./WaveformsPanel.js', () => ({
  WaveformsPanel: () => <div>波形视图</div>,
}));

vi.mock('./settings/DataTab.js', () => ({
  DataTab: ({ onExport }: { onExport: (ids: string[]) => void }) => (
    <button type="button" onClick={() => onExport(['session-1'])}>
      导出会话
    </button>
  ),
}));

afterEach(cleanup);

function makeProps({
  onToggleSensorTriggers = vi.fn(),
  onExport = vi.fn(),
}: {
  onToggleSensorTriggers?: (enabled: boolean) => void;
  onExport?: (ids: string[]) => void;
} = {}): AgentModuleProjectionsProps {
  const settings = defaultBrowserAppSettings();
  const setSettings = vi.fn();
  return {
    debug: {
      bridge: { settingsDraft: settings, setSettingsDraft: setSettings },
      bridgeLogs: { bridgeLogs: [], bridgeStatus: null, settings },
      modelLogs: {
        settingsDraft: settings,
        setSettingsDraft: setSettings,
        turns: [],
        onClear: vi.fn(),
      },
    },
    sensors: {
      settingsDraft: settings,
      setSettingsDraft: setSettings,
      sensorTriggersEnabled: false,
      onToggleSensorTriggers,
      deviceLinkRule: DEFAULT_DEVICE_LINK_RULE,
      onSetDeviceLinkRule: vi.fn(),
    },
    waveforms: {
      waveforms: [],
      customWaveforms: [],
      onImport: vi.fn(),
      onImportFromMarket: vi.fn(),
      onRemove: vi.fn(),
      onEdit: vi.fn(),
    },
    data: { sessions: [], onExport, onImport: vi.fn() },
  };
}

describe('AgentModuleProjections', () => {
  it('registers prepared settings projections and delegates their actions', () => {
    const onToggleSensorTriggers = vi.fn();
    const onExport = vi.fn();

    render(<AgentModuleProjections {...makeProps({ onToggleSensorTriggers, onExport })} />);

    expect(screen.getByTestId('agent-sensors').getAttribute('aria-label')).toBe('传感器');
    expect(screen.getByTestId('agent-waveforms').getAttribute('aria-label')).toBe('波形');
    expect(screen.getByTestId('agent-data').getAttribute('aria-label')).toBe('数据');

    fireEvent.click(screen.getByText('启用传感器'));
    fireEvent.click(screen.getByText('导出会话'));
    expect(onToggleSensorTriggers).toHaveBeenCalledWith(true);
    expect(onExport).toHaveBeenCalledWith(['session-1']);
  });

  it('owns only the debug panel open and close interaction', () => {
    render(<AgentModuleProjections {...makeProps()} />);

    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByLabelText('打开调试面板'));
    expect(screen.getByRole('dialog', { name: '调试面板' })).not.toBeNull();
    fireEvent.click(screen.getByText('关闭调试面板'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
