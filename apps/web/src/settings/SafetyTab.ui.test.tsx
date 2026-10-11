// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
vi.mock('@0xnullai/ui', () => ({ ModuleSettingsSlot: () => null }));

afterEach(() => {
  cleanup();
  safety.update.mockClear();
});

it('exposes the same vibration turn limits enforced by the shared safety policy', () => {
  render(<SafetyTab />);
  fireEvent.click(screen.getByText('单回合上限'));
  const adjust = screen.getByLabelText(/单回合振动调节次数/);
  const burst = screen.getByLabelText(/单回合振动脉冲次数/);
  expect(adjust).toBeTruthy();
  expect(burst).toBeTruthy();

  fireEvent.change(adjust, { target: { value: '3' } });
  expect(safety.update).toHaveBeenCalledWith(
    expect.objectContaining({ maxVibrateAdjustCallsPerTurn: 3 }),
  );
});
