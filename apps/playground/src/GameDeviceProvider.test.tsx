import { act, renderHook } from '@testing-library/react';
import type { SafetySessionSpec } from '@0xnullai/ui';
import { GameDeviceProvider } from './GameDeviceProvider';
import { useGameDevice } from './use-game-device';

const mocks = vi.hoisted(() => ({
  lease: false,
  safetySpec: null as SafetySessionSpec | null,
  device: {
    coyotes: [] as Array<{ id: string; connected: boolean }>,
    sensor: null as { connected: boolean } | null,
    opossum: null as { connected: boolean } | null,
    connectDevice: vi.fn(),
    disconnectCoyote: vi.fn(),
    disconnectSensor: vi.fn(),
    disconnectOpossum: vi.fn(),
    setWave: vi.fn(),
    setStrength: vi.fn(),
    stopAll: vi.fn(),
    opossumBurst: vi.fn(),
  },
}));

vi.mock('@0xnullai/native', () => ({
  useNativeBridge: () => ({}),
}));

vi.mock('@0xnullai/settings', () => ({
  loadDeviceSafety: () => ({
    maxStrengthA: 50,
    maxColdStartStrength: 10,
    maxBurstStrengthAbsolute: 0,
    maxBurstStrengthRelative: 0,
    maxIntensityA: 50,
    maxColdStartIntensity: 10,
    maxBurstDurationMs: 5_000,
  }),
}));

vi.mock('@0xnullai/ui', () => ({
  useSafetySession: (spec: SafetySessionSpec) => {
    mocks.safetySpec = spec;
  },
}));

vi.mock('@dg-kit/safety', () => ({
  currentDeviceLease: () => (mocks.lease ? 'playground' : null),
  hasDeviceLease: (id: string) => mocks.lease && id === 'playground',
  subscribeSafetySessions: () => () => undefined,
}));

vi.mock('@dg-kit/waveforms', () => ({
  listBuiltinWaveforms: () => [
    { id: 'pulse_low', frames: [{ frequency: 25, strength: 5 }] },
    { id: 'pulse_mid', frames: [{ frequency: 35, strength: 10 }] },
  ],
}));

vi.mock('../../chat/src/hooks/use-device', () => ({
  useDevice: () => mocks.device,
}));

vi.mock('../../control/src/lib/attached-devices', () => ({
  holdsAnyDevice: ({ coyotes, sensor, opossum }: typeof mocks.device) =>
    coyotes.some((device) => device.connected) || Boolean(sensor?.connected || opossum?.connected),
  attachedDeviceSummaries: () => [],
}));

function renderGameDevice() {
  return renderHook(() => useGameDevice(), {
    wrapper: ({ children }) => <GameDeviceProvider>{children}</GameDeviceProvider>,
  });
}

describe('GameDeviceProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.lease = false;
    mocks.safetySpec = null;
    mocks.device.coyotes = [];
    mocks.device.sensor = null;
    mocks.device.opossum = null;
    for (const fn of [
      mocks.device.connectDevice,
      mocks.device.disconnectCoyote,
      mocks.device.disconnectSensor,
      mocks.device.disconnectOpossum,
      mocks.device.setWave,
      mocks.device.setStrength,
      mocks.device.stopAll,
      mocks.device.opossumBurst,
    ]) {
      fn.mockReset();
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers the shared device-bar session and routes disconnects by device kind', () => {
    const view = renderGameDevice();

    expect(mocks.safetySpec).toMatchObject({ id: 'playground', label: 'Playground' });
    expect(mocks.safetySpec?.isActive()).toBe(false);

    mocks.safetySpec?.connect?.();
    mocks.safetySpec?.disconnect?.('coyote-2');
    mocks.safetySpec?.disconnect?.('paw-prints');
    mocks.safetySpec?.disconnect?.('opossum');

    expect(mocks.device.connectDevice).toHaveBeenCalledOnce();
    expect(mocks.device.disconnectCoyote).toHaveBeenCalledWith('coyote-2');
    expect(mocks.device.disconnectSensor).toHaveBeenCalledOnce();
    expect(mocks.device.disconnectOpossum).toHaveBeenCalledOnce();
    view.unmount();
  });

  it('does not send output without the Playground device lease', () => {
    mocks.device.coyotes = [{ id: 'coyote-1', connected: true }];
    const { result, unmount } = renderGameDevice();

    expect(result.current.connected).toBe(true);
    expect(result.current.holdsLease).toBe(false);
    act(() => result.current.pulse('strong'));

    expect(mocks.device.setWave).not.toHaveBeenCalled();
    expect(mocks.device.setStrength).not.toHaveBeenCalled();
    expect(mocks.device.opossumBurst).not.toHaveBeenCalled();
    unmount();
  });

  it('plays a capped Coyote waveform and invalidates it at the duration boundary', () => {
    mocks.lease = true;
    mocks.device.coyotes = [{ id: 'coyote-1', connected: true }];
    const { result, unmount } = renderGameDevice();

    expect(result.current.holdsLease).toBe(true);
    act(() => result.current.pulse('strong'));

    expect(mocks.device.stopAll).toHaveBeenCalledOnce();
    expect(mocks.device.setWave).toHaveBeenCalledWith(
      'A',
      [{ frequency: 35, strength: 10 }],
      'pulse_mid',
      true,
      'coyote-1',
    );
    expect(mocks.device.setStrength).toHaveBeenCalledWith('A', 10, 'coyote-1');
    expect(mocks.device.opossumBurst).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(450));
    expect(mocks.device.stopAll).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('uses Opossum when no Coyote is connected', () => {
    mocks.lease = true;
    mocks.device.opossum = { connected: true };
    const { result, unmount } = renderGameDevice();

    act(() => result.current.pulse('light'));

    expect(mocks.device.opossumBurst).toHaveBeenCalledWith('A', 5, 250);
    expect(mocks.device.setWave).not.toHaveBeenCalled();
    expect(mocks.device.setStrength).not.toHaveBeenCalled();
    unmount();
  });
});
