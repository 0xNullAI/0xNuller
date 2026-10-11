// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserAppSettings } from '@dg-agent/storage-browser';
import type { SavedScene } from '@0xnullai/scenes';
import { setDeviceConversationAccess } from '@0xnullai/settings';
import { grantDeviceLease } from '@dg-kit/safety';
import type { DgLabModuleHandle } from '@dg-agent/agent-browser';

const { createBrowserServices, createRegistryAgentDevices } = vi.hoisted(() => ({
  createBrowserServices: vi.fn(
    (_options?: {
      device?: unknown;
      opossum?: unknown;
      bluetoothAvailabilityOverride?: unknown;
      deviceExecutionGate?: (input: {
        sessionId: string;
        context: { sourceType: string };
      }) => boolean;
    }) => ({
      client: { dispose: vi.fn() },
      warnings: [],
    }),
  ),
  createRegistryAgentDevices: vi.fn((handle: unknown) => ({
    device: { from: handle },
    opossum: { from: handle },
    pawPrints: { from: handle },
    civetEdging: { from: handle },
  })),
}));

const auth = vi.hoisted(() => ({ id: null as string | null, listener: () => {} }));
vi.mock('@0xnullai/auth', () => ({
  currentAuthUserId: () => auth.id,
  subscribeAuthChanges: (listener: () => void) => {
    auth.listener = listener;
    return () => {};
  },
}));

vi.mock('@dg-agent/agent-browser', () => ({
  createBrowserServices,
  createRegistryAgentDevices,
}));

import { useBrowserAppServices, type ServicesOverrides } from './use-browser-app-services';

const servicesOverrides: ServicesOverrides = { disableUpdateChecker: true };
const dglab = { moduleId: 'agent' } as unknown as DgLabModuleHandle;
const settings = {} as BrowserAppSettings;
const saved: SavedScene[] = [];
const setPendingPermission = vi.fn();
const resolveBridgeSessionId = () => null;

describe('useBrowserAppServices', () => {
  beforeEach(() => {
    vi.stubGlobal('__BUILD_ID__', 'test');
    createBrowserServices.mockClear();
    auth.id = null;
  });

  it('普通重渲染不会因 scenes 包装对象变化而销毁正在流式输出的 runtime', () => {
    const { rerender } = renderHook(
      ({ scenes }) =>
        useBrowserAppServices({
          settings,
          scenes,
          setPendingPermission,
          resolveBridgeSessionId,
          servicesOverrides,
          dglab,
        }),
      { initialProps: { scenes: { selectedId: 'default', saved } } },
    );

    expect(createBrowserServices).toHaveBeenCalledTimes(1);
    rerender({ scenes: { selectedId: 'default', saved } });
    expect(createBrowserServices).toHaveBeenCalledTimes(1);
  });
});

it('requires an exact account and AI conversation grant at the final device gate', () => {
  localStorage.clear();
  auth.id = 'alice';
  vi.stubGlobal('__BUILD_ID__', 'test');
  const { unmount } = renderHook(() =>
    useBrowserAppServices({
      settings,
      scenes: { selectedId: 'default', saved },
      setPendingPermission,
      resolveBridgeSessionId,
      servicesOverrides,
      dglab,
    }),
  );
  const gate = createBrowserServices.mock.lastCall?.[0]?.deviceExecutionGate;
  expect(gate).toBeDefined();
  const input = { sessionId: 'a', context: { sourceType: 'web' } };
  expect(gate?.(input)).toBe(false);
  expect(setDeviceConversationAccess('alice', 'ai', 'a', true)).toBe(true);
  expect(gate?.(input)).toBe(true);
  expect(gate?.({ ...input, sessionId: 'b' })).toBe(false);
  auth.id = 'bob';
  expect(gate?.(input)).toBe(false);
  unmount();
});

it('does not treat the mobile inbox null lease as an active Agent lease', async () => {
  localStorage.clear();
  auth.id = 'alice';
  vi.stubGlobal('__BUILD_ID__', 'test');
  await grantDeviceLease(null);
  expect(setDeviceConversationAccess('alice', 'ai', 'a', true)).toBe(true);
  const { unmount } = renderHook(() =>
    useBrowserAppServices({
      inShell: true,
      settings,
      scenes: { selectedId: 'default', saved },
      setPendingPermission,
      resolveBridgeSessionId,
      servicesOverrides,
      dglab,
    }),
  );
  const gate = createBrowserServices.mock.lastCall?.[0]?.deviceExecutionGate;
  expect(gate?.({ sessionId: 'a', context: { sourceType: 'web' } })).toBe(false);
  unmount();
});

it('rebuilds account runtime while preserving physical devices and ignores same-account refreshes', () => {
  createBrowserServices.mockClear();
  auth.id = null;
  vi.stubGlobal('__BUILD_ID__', 'test');
  const { unmount } = renderHook(() =>
    useBrowserAppServices({
      settings,
      scenes: { selectedId: 'default', saved },
      setPendingPermission,
      resolveBridgeSessionId,
      servicesOverrides,
      dglab,
    }),
  );
  const originalDevice = createBrowserServices.mock.calls[0]?.[0]?.device;
  const dispose = createBrowserServices.mock.results[0]!.value.client.dispose;
  act(() => {
    auth.id = 'alice';
    auth.listener();
  });
  expect(dispose).toHaveBeenCalledOnce();
  expect(createBrowserServices).toHaveBeenCalledTimes(2);
  expect(createBrowserServices.mock.calls[1]?.[0]?.device).toBe(originalDevice);
  act(() => auth.listener());
  expect(createBrowserServices).toHaveBeenCalledTimes(2);
  unmount();
});

it('takes every device client from the shared registry', () => {
  createBrowserServices.mockClear();
  const handle = { moduleId: 'agent' } as unknown as DgLabModuleHandle;
  vi.stubGlobal('__BUILD_ID__', 'test');
  const { unmount } = renderHook(() =>
    useBrowserAppServices({
      settings,
      scenes: { selectedId: 'default', saved },
      setPendingPermission,
      resolveBridgeSessionId,
      servicesOverrides,
      dglab: handle,
      nativeBluetooth: true,
    }),
  );
  const options = createBrowserServices.mock.lastCall?.[0];
  expect(options?.device).toEqual({ from: handle });
  expect(options?.opossum).toEqual({ from: handle });
  expect(options?.bluetoothAvailabilityOverride).toEqual({ supported: true });
  unmount();
});
