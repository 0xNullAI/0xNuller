// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserAppSettings } from '@dg-agent/storage-browser';
import type { SavedScene } from '@0xnullai/scenes';

const { createBrowserServices, MultiCoyoteDeviceClient } = vi.hoisted(() => ({
  createBrowserServices: vi.fn(() => ({
    client: { dispose: vi.fn() },
    warnings: [],
  })),
  MultiCoyoteDeviceClient: vi.fn(function (
    this: unknown,
    createClient: (protocol: unknown) => unknown,
  ) {
    return createClient({});
  }),
}));

vi.mock('@dg-agent/agent-browser', () => ({ createBrowserServices, MultiCoyoteDeviceClient }));

import { useBrowserAppServices, type ServicesOverrides } from './use-browser-app-services';

const device = {};
const servicesOverrides = {
  createDeviceClient: () => device,
  createOpossumClient: () => ({}),
  createPawPrintsClient: () => ({}),
  createCivetEdgingClient: () => ({}),
  disableUpdateChecker: true,
} as unknown as ServicesOverrides;
const settings = {} as BrowserAppSettings;
const saved: SavedScene[] = [];
const setPendingPermission = vi.fn();
const resolveBridgeSessionId = () => null;

describe('useBrowserAppServices', () => {
  beforeEach(() => {
    vi.stubGlobal('__BUILD_ID__', 'test');
    createBrowserServices.mockClear();
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
        }),
      { initialProps: { scenes: { selectedId: 'default', saved } } },
    );

    expect(createBrowserServices).toHaveBeenCalledTimes(1);
    rerender({ scenes: { selectedId: 'default', saved } });
    expect(createBrowserServices).toHaveBeenCalledTimes(1);
  });
});
