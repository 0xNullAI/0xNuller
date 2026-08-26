import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeBridgeProvider } from '@0xnullai/native';
import {
  WebEmbeddedDeviceRuntimeProvider,
  type BackendEvent,
  type DeviceBackend,
  type DeviceBackendSession,
} from '@0xnullai/device-runtime';
import { currentDeviceLeaseSnapshot, grantDeviceLease } from '@dg-kit/safety';
import { EmbeddedDevicePanel } from './EmbeddedDevicePanel';

const cleanups: Array<() => void | Promise<void>> = [];

beforeEach(async () => {
  localStorage.clear();
  await grantDeviceLease('control');
});

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  await grantDeviceLease(null);
});

function runtimeHarness() {
  let emit: ((event: BackendEvent) => void) | null = null;
  const topology: BackendEvent = {
    version: 1,
    type: 'topology',
    devices: [
      {
        nativeDeviceId: 'alpha',
        name: 'Device Alpha',
        capabilities: [
          { kind: 'vibrate', nativeFeatureId: 'alpha-motor-a', stepCount: 20 },
          { kind: 'vibrate', nativeFeatureId: 'alpha-motor-b', stepCount: 10 },
          { kind: 'battery', nativeFeatureId: 'alpha-battery', value: 0.73 },
        ],
      },
      {
        nativeDeviceId: 'beta',
        name: 'Device Beta',
        capabilities: [{ kind: 'rssi', nativeFeatureId: 'beta-rssi', value: -58 }],
      },
    ],
  };
  const session: DeviceBackendSession = {
    scan: vi.fn(async () => emit?.(topology)),
    disconnect: vi.fn(async () => undefined),
    writeVibrate: vi.fn(async () => undefined),
    stopFeature: vi.fn(async () => undefined),
    stopAll: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const backend: DeviceBackend = {
    openSession: vi.fn(async (onEvent) => {
      emit = onEvent as (event: BackendEvent) => void;
      return session;
    }),
  };
  const provider = new WebEmbeddedDeviceRuntimeProvider({
    backendFactory: () => backend,
    executorOptions: {
      permissionPolicy: { authorize: async () => 'allow' },
      safetyPolicy: () => ({
        intensityCap: 1,
        maxIncrease: 1,
        coldStartCap: 1,
        maxOutputLeaseMs: 5_000,
      }),
      leaseSnapshot: currentDeviceLeaseSnapshot,
    },
  });
  cleanups.push(() => provider.stop());
  return { provider, backend, session };
}

describe('EmbeddedDevicePanel', () => {
  it('stays hidden and does not initialize the backend until the local experiment is enabled', async () => {
    const runtime = runtimeHarness();
    render(
      <NativeBridgeProvider bridge={{ deviceRuntime: runtime.provider }} native={false}>
        <EmbeddedDevicePanel />
      </NativeBridgeProvider>,
    );

    expect(screen.queryByRole('button', { name: '扫描通用设备' })).toBeNull();
    expect(runtime.backend.openSession).not.toHaveBeenCalled();

    await act(() => runtime.provider.setEnabled(true));
    expect(await screen.findByRole('button', { name: '扫描通用设备' })).toBeTruthy();
    expect(runtime.backend.openSession).not.toHaveBeenCalled();

    await act(() => runtime.provider.setEnabled(false));
    expect(screen.queryByRole('button', { name: '扫描通用设备' })).toBeNull();
    expect(runtime.backend.openSession).not.toHaveBeenCalled();
  });

  it('lists every exact device feature and stops vibration on pointer release', async () => {
    const runtime = runtimeHarness();
    await runtime.provider.setEnabled(true);
    render(
      <NativeBridgeProvider bridge={{ deviceRuntime: runtime.provider }} native={false}>
        <EmbeddedDevicePanel />
      </NativeBridgeProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: '扫描通用设备' }));
    expect(await screen.findByRole('heading', { name: 'Device Alpha' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Device Beta' })).toBeTruthy();
    expect(screen.getAllByText(/· Vibrate$/)).toHaveLength(2);
    expect(screen.getByText(/· Battery$/)).toBeTruthy();
    expect(screen.getByText(/· RSSI$/)).toBeTruthy();
    expect(screen.getByText('73%')).toBeTruthy();
    expect(screen.getByText('-58 dBm')).toBeTruthy();

    const intensity = screen.getByRole('slider', {
      name: 'Device Alpha 功能 1 归一化振动强度',
    });
    fireEvent.change(intensity, { target: { value: '0.2' } });
    await waitFor(() => expect(runtime.session.writeVibrate).toHaveBeenCalledTimes(1));

    fireEvent.pointerUp(intensity);
    await waitFor(() => expect(runtime.session.stopFeature).toHaveBeenCalled());
    expect((intensity as HTMLInputElement).value).toBe('0');
  });
});
