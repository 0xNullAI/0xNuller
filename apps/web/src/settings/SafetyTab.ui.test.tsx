// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SafetyTab } from './SafetyTab';

const safety = vi.hoisted(() => ({
  settings: {
    maxStrengthA: 50,
    maxStrengthB: 50,
    maxColdStartStrength: 10,
    maxAdjustStep: 10,
    maxBurstDurationMs: 5000,
    maxBurstStrengthAbsolute: 0,
    maxBurstStrengthRelative: 0,
    burstRequiresActiveChannel: true,
    maxIntensityA: 50,
    maxIntensityB: 50,
    maxColdStartIntensity: 10,
    maxOpossumAdjustStep: 10,
    maxToolIterations: 8,
    maxToolCallsPerTurn: 12,
    maxAdjustStrengthCallsPerTurn: 4,
    maxBurstCallsPerTurn: 2,
    maxVibrateAdjustCallsPerTurn: 4,
    maxVibrateBurstCallsPerTurn: 2,
    permissionMode: 'confirm',
  },
  update: vi.fn(),
}));

vi.mock('@0xnullai/settings', () => ({
  DEFAULT_DEVICE_SAFETY: safety.settings,
  loadDeviceSafety: () => ({ ...safety.settings }),
  subscribeDeviceSafety: () => () => undefined,
  updateDeviceSafety: (change: (current: typeof safety.settings) => typeof safety.settings) => {
    safety.settings = change(safety.settings);
    safety.update(safety.settings);
    return safety.settings;
  },
}));
vi.mock('@0xnullai/ui', () => ({
  ModuleSettingsSlot: () => null,
  useSettingsSubpage: () => false,
}));

afterEach(() => {
  cleanup();
  safety.update.mockClear();
});

it('shows only the channel caps first and keeps the rest on one flat 高级 page', () => {
  const { container } = render(<SafetyTab />);
  const coyote = screen.getByRole('region', { name: '郊狼' });
  expect(within(coyote).getByLabelText(/A 通道上限/)).toBeTruthy();
  expect(screen.getByRole('region', { name: '负鼠' })).toBeTruthy();
  expect(screen.getByLabelText(/设备指令确认/)).toBeTruthy();
  expect(screen.queryByLabelText(/冷启动上限/)).toBeNull();
  // Per-turn caps are fixed constants and have no control.
  expect(screen.queryByText(/单回合/)).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: '高级' }));
  expect(container.querySelector('details')).toBeNull();
  const burst = screen.getByLabelText(/脉冲最长时长/);
  expect(screen.getAllByLabelText(/冷启动上限/)).toHaveLength(2);
  expect(screen.queryByText(/单回合/)).toBeNull();
  fireEvent.change(burst, { target: { value: '3000' } });
  expect(safety.update).toHaveBeenCalledWith(expect.objectContaining({ maxBurstDurationMs: 3000 }));

  fireEvent.click(screen.getByRole('button', { name: '返回上一页' }));
  expect(screen.getByRole('button', { name: '高级' })).toBeTruthy();
});
