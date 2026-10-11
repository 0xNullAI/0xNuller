import { act, renderHook } from '@testing-library/react';
import type { SafetySessionSpec } from '@0xnullai/ui';
import { GameDeviceProvider } from './GameDeviceProvider';
import { useGameDevice } from './use-game-device';

const mocks = vi.hoisted(() => ({
  lease: false,
  moduleId: null as string | null,
  safetySpec: null as SafetySessionSpec | null,
  device: {
    coyotes: [] as Array<{ id: string; connected: boolean }>,
    sensor: null as { connected: boolean } | null,
    opossum: null as { connected: boolean } | null,
    connectDevice: vi.fn(),
    setWave: vi.fn(),
    setStrength: vi.fn(),
    stopAll: vi.fn(),
    opossumBurst: vi.fn(),
  },
}));

vi.mock('@0xnullai/native', () => ({
  useDgLabRegistry: () => ({}),
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

vi.mock('@0xnullai/device-runtime', () => ({
  useDevice: (options: { moduleId: string }) => {
    mocks.moduleId = options.moduleId;
    return mocks.device;
  },
  holdsAnyDevice: ({ coyotes, sensor, opossum }: typeof mocks.device) =>
    coyotes.some((device) => device.connected) || Boolean(sensor?.connected || opossum?.connected),
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

  it('uses its own lease id and leaves the device list to the shared registry session', () => {
    const view = renderGameDevice();

    expect(mocks.moduleId).toBe('playground');
    expect(mocks.safetySpec).toMatchObject({ id: 'playground', label: 'Playground' });
    expect(mocks.safetySpec?.isActive()).toBe(false);
    // Listing here as well would show every device twice in the bar.
    expect(mocks.safetySpec?.devices).toBeUndefined();
    expect(mocks.safetySpec?.disconnect).toBeUndefined();

    mocks.safetySpec?.connect?.();
    expect(mocks.device.connectDevice).toHaveBeenCalledOnce();
    view.unmount();
  });

  it('does not zero shared output on unmount unless Playground holds the lease', () => {
    mocks.device.coyotes = [{ id: 'coyote-1', connected: true }];
    renderGameDevice().unmount();
    expect(mocks.device.stopAll).not.toHaveBeenCalled();

    mocks.lease = true;
    renderGameDevice().unmount();
    expect(mocks.device.stopAll).toHaveBeenCalledOnce();
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

  it('on lease loss drops its pulse timer without stopping the new holder', () => {
    mocks.lease = true;
    mocks.device.coyotes = [{ id: 'coyote-1', connected: true }];
    const { result, unmount } = renderGameDevice();
    act(() => result.current.pulse('strong'));
    expect(mocks.device.stopAll).toHaveBeenCalledOnce();

    // The registry already stopped every output. A stop from here would bypass the fence and
    // zero whatever the new holder starts, including the pulse timer firing later.
    mocks.lease = false;
    void mocks.safetySpec?.onRevoke?.();
    act(() => vi.advanceTimersByTime(1_000));

    expect(mocks.device.stopAll).toHaveBeenCalledOnce();
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
