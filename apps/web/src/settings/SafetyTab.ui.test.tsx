// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    backgroundKeepMinutes: 0,
  },
  update: vi.fn(),
  keepMax: 30,
  keepReady: true,
  hint: undefined as string | undefined,
  prepare: vi.fn(async () => false),
}));

vi.mock('@0xnullai/settings', () => ({
  backgroundKeepOptions: () => [0, 5, 10, 30].filter((minutes) => minutes <= safety.keepMax),
  backgroundKeepHint: () => safety.hint,
  effectiveBackgroundKeepMinutes: () =>
    safety.keepReady ? Math.min(safety.settings.backgroundKeepMinutes, safety.keepMax) : 0,
  isBackgroundKeepReady: () => safety.keepReady,
  isBackgroundKeepSupported: () => safety.keepMax > 0,
  prepareBackgroundKeep: () => safety.prepare(),
  DEFAULT_DEVICE_SAFETY: safety.settings,
  loadDeviceSafety: () => ({ ...safety.settings }),
  subscribeDeviceSafety: () => () => undefined,
  updateDeviceSafety: (change: (current: typeof safety.settings) => typeof safety.settings) => {
    safety.settings = change(safety.settings);
    safety.update(safety.settings);
    return safety.settings;
  },
}));
vi.mock('@0xnullai/ui', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ModuleSettingsSlot: () => null,
  useSettingsSubpage: () => false,
}));
const registry = vi.hoisted(() => ({
  setOwnLimits: vi.fn(async () => undefined),
  forgetDeviceLimits: vi.fn(),
}));
const devices = vi.hoisted(() => [
  {
    stableKey: 'coyote:id:1',
    kind: 'coyote',
    name: '郊狼 #1',
    id: 'c1',
    connected: true,
    battery: 80,
    ownLimits: { a: 30, b: 200 },
    globalLimits: { a: 50, b: 50 },
    effectiveLimits: { a: 30, b: 50 },
  },
  {
    stableKey: 'opossum:id:2',
    kind: 'opossum',
    name: '负鼠',
    id: null,
    connected: false,
    battery: null,
    ownLimits: { a: 200, b: 200 },
    globalLimits: { a: 50, b: 50 },
    effectiveLimits: { a: 50, b: 50 },
  },
]);
vi.mock('@0xnullai/native', () => ({ useDgLabRegistry: () => registry }));
vi.mock('@0xnullai/device-runtime', () => ({ useDgLabDeviceLimits: () => devices }));

afterEach(() => {
  cleanup();
  safety.update.mockClear();
  registry.setOwnLimits.mockClear();
  registry.forgetDeviceLimits.mockClear();
  safety.keepMax = 30;
  safety.keepReady = true;
  safety.hint = undefined;
  safety.settings.backgroundKeepMinutes = 0;
  safety.prepare.mockReset();
  safety.prepare.mockResolvedValue(false);
});

function keepOptions() {
  const select = screen.getByLabelText('切到后台时') as HTMLSelectElement;
  return [...select.options].map((option) => option.value);
}

it('shows shared limits, every device with its effective limit, and controls', () => {
  render(<SafetyTab />);
  const shared = screen.getByRole('region', { name: '所有设备共用的上限' });
  for (const label of ['郊狼 A 通道', '郊狼 B 通道', '负鼠 A 通道', '负鼠 B 通道'])
    expect(within(shared).getByLabelText(label)).toBeTruthy();
  fireEvent.change(within(shared).getByLabelText('郊狼 A 通道'), { target: { value: '40' } });
  expect(safety.update).toHaveBeenCalledWith(expect.objectContaining({ maxStrengthA: 40 }));

  const mine = screen.getByRole('region', { name: '我的设备' });
  expect(within(mine).getByRole('button', { name: /郊狼 #1.*电量 80%.*A 30 · B 50/ })).toBeTruthy();
  expect(within(mine).getByRole('button', { name: /负鼠.*未连接/ })).toBeTruthy();
  expect(screen.getByLabelText('设备指令确认')).toBeTruthy();
  // Per-turn AI caps are fixed constants and never shown.
  expect(screen.queryByText(/单回合|每回合/)).toBeNull();
});

it('sets one device’s own limit and forgets a disconnected one', () => {
  render(<SafetyTab />);
  fireEvent.click(screen.getByRole('button', { name: /郊狼 #1/ }));
  expect(screen.getByText(/实际生效：A 30 · B 50/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('A 通道'), { target: { value: '20' } });
  expect(registry.setOwnLimits).toHaveBeenCalledWith('coyote:id:1', { a: 20 });
  // A connected device cannot be forgotten.
  expect(screen.queryByRole('button', { name: '忘记这台设备' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '返回上一页' }));

  fireEvent.click(screen.getByRole('button', { name: /负鼠.*未连接/ }));
  fireEvent.click(screen.getByRole('button', { name: '忘记这台设备' }));
  expect(registry.forgetDeviceLimits).toHaveBeenCalledWith('opossum:id:2');
});

it('keeps start, step and burst limits on one flat 高级 page', () => {
  const { container } = render(<SafetyTab />);
  expect(screen.queryByLabelText('启动上限')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '高级' }));
  expect(container.querySelector('details')).toBeNull();
  expect(screen.getAllByLabelText('启动上限')).toHaveLength(2);
  fireEvent.change(screen.getByLabelText('最长时长'), { target: { value: '3000' } });
  expect(safety.update).toHaveBeenCalledWith(expect.objectContaining({ maxBurstDurationMs: 3000 }));
  fireEvent.click(screen.getByRole('button', { name: '返回上一页' }));
  expect(screen.getByRole('button', { name: '高级' })).toBeTruthy();
});

it('chooses how long output may keep running in the background, only where supported', () => {
  render(<SafetyTab />);
  const select = screen.getByLabelText('切到后台时') as HTMLSelectElement;
  expect(select.value).toBe('0');
  fireEvent.change(select, { target: { value: '10' } });
  expect(safety.update).toHaveBeenCalledWith(
    expect.objectContaining({ backgroundKeepMinutes: 10 }),
  );
  cleanup();

  safety.keepMax = 0;
  render(<SafetyTab />);
  expect(screen.queryByLabelText('切到后台时')).toBeNull();
  expect(screen.getByText('切到后台时立即停止所有设备。')).toBeTruthy();
});

it('lists 5/10/30 on the web and only 5/10 where the platform caps it', () => {
  render(<SafetyTab />);
  expect(keepOptions()).toEqual(['0', '5', '10', '30']);
  cleanup();

  safety.keepMax = 10;
  safety.hint = '安卓需要通知权限。';
  safety.settings.backgroundKeepMinutes = 30;
  render(<SafetyTab />);
  expect(keepOptions()).toEqual(['0', '5', '10']);
  // A 30-minute choice from another device shows (and applies) as this platform's cap.
  expect((screen.getByLabelText('切到后台时') as HTMLSelectElement).value).toBe('10');
  expect(screen.getByText(/安卓需要通知权限。/)).toBeTruthy();
});

it('asks for the notification permission first and keeps 0 when it is refused', async () => {
  safety.keepMax = 10;
  safety.keepReady = false;
  render(<SafetyTab />);

  fireEvent.change(screen.getByLabelText('切到后台时'), { target: { value: '5' } });

  await waitFor(() => expect(screen.getByText(/未获得通知权限/)).toBeTruthy());
  expect(safety.prepare).toHaveBeenCalledTimes(1);
  expect(safety.update).toHaveBeenLastCalledWith(
    expect.objectContaining({ backgroundKeepMinutes: 0 }),
  );
  expect((screen.getByLabelText('切到后台时') as HTMLSelectElement).value).toBe('0');
});

it('stores the keep once the permission is granted', async () => {
  safety.keepMax = 10;
  safety.keepReady = false;
  safety.prepare.mockImplementation(async () => {
    safety.keepReady = true;
    return true;
  });
  render(<SafetyTab />);

  fireEvent.change(screen.getByLabelText('切到后台时'), { target: { value: '10' } });

  await waitFor(() =>
    expect(safety.update).toHaveBeenCalledWith(
      expect.objectContaining({ backgroundKeepMinutes: 10 }),
    ),
  );
  expect(screen.queryByText(/未获得通知权限/)).toBeNull();
});
