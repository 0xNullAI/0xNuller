import { afterAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { DGLAB_SAFETY_SESSION_ID, type DgLabConnectionRegistry } from '@0xnullai/device-runtime';
import { useDgLabRegistry, useNativeBridge } from '@0xnullai/native';
import { safetySessionById } from '@dg-kit/safety';
import { DeviceBar } from '../DeviceBar';
import type * as DgLabDeviceRegistryModule from '../dglab-device-registry';

/**
 * The Web shell builds exactly one DG-Lab registry before render and every module reaches that
 * same instance through `useDgLabRegistry()`. The real Shell is replaced with a probe: modules are
 * lazy real apps that cannot run under jsdom, and only the composition matters here.
 */

const seen = vi.hoisted(() => ({
  created: [] as DgLabConnectionRegistry[],
  fromHook: [] as DgLabConnectionRegistry[],
  fromBridge: [] as (DgLabConnectionRegistry | undefined)[],
}));

vi.mock('../dglab-device-registry', async (importOriginal) => {
  const original = await importOriginal<typeof DgLabDeviceRegistryModule>();
  return {
    createUnifiedShellDgLabRegistry: (
      ...args: Parameters<typeof original.createUnifiedShellDgLabRegistry>
    ) => {
      const registry = original.createUnifiedShellDgLabRegistry(...args);
      seen.created.push(registry);
      return registry;
    },
  };
});

vi.mock('../Shell', () => ({
  Shell: () => {
    seen.fromHook.push(useDgLabRegistry());
    seen.fromBridge.push(useNativeBridge().dglab);
    return <div data-testid="shell-probe" />;
  },
}));

afterAll(async () => {
  cleanup();
  await Promise.all(seen.created.map((registry) => registry.dispose()));
});

describe('Web bootstrap DG-Lab registry', () => {
  it('creates one registry before render and hands the same instance to every module', async () => {
    document.body.innerHTML = '<div id="root"></div>';
    await import('../bootstrap');
    await waitFor(() =>
      expect(document.querySelector('[data-testid="shell-probe"]')).not.toBe(null),
    );

    expect(seen.created).toHaveLength(1);
    const [registry] = seen.created;
    // StrictMode renders the probe twice; both renders must see the shell instance, not a fallback.
    expect(seen.fromHook.length).toBeGreaterThan(0);
    expect(seen.fromHook.every((value) => value === registry)).toBe(true);
    expect(seen.fromBridge.every((value) => value === registry)).toBe(true);

    // Registered for stop-all, but lists nothing until a module connects through it.
    expect(safetySessionById(DGLAB_SAFETY_SESSION_ID)?.devices?.()).toEqual([]);
  });

  it('does not give the device bar a second connect entry', () => {
    // The bar only offers the connect of the session whose id is the lease-holding module.
    // `dglab-devices` is never a module id, so its registered connect stays unreachable here.
    expect(typeof safetySessionById(DGLAB_SAFETY_SESSION_ID)?.connect).toBe('function');
    for (const moduleId of ['control', 'agent', 'voice', 'video', 'chat', 'playground']) {
      const { container, unmount } = render(<DeviceBar activeSessionId={moduleId} showConnect />);
      expect(container.textContent).not.toContain('连接设备');
      unmount();
    }
  });
});
