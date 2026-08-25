import { describe, expect, it, vi } from 'vitest';
import type { DeviceRuntimeProvider, SharedDeviceRuntime } from './runtime-provider.js';
import { createDeviceInteractionId, DeviceRuntimeModuleBinding } from './module-binding.js';

function runtimeHarness() {
  let snapshotListener: ((snapshot: never) => void) | null = null;
  const snapshot = { sessionId: 'session-1', devices: [] } as never;
  const tools = { actions: {} } as never;
  const runtime = {
    manager: {
      subscribe: vi.fn((listener) => {
        snapshotListener = listener;
        return vi.fn();
      }),
    },
    snapshot: vi.fn(() => snapshot),
    forModule: vi.fn(() => tools),
  } as unknown as SharedDeviceRuntime;
  let current: SharedDeviceRuntime | null = null;
  const provider = {
    current: vi.fn(() => current),
    start: vi.fn(async () => {
      current = runtime;
      return runtime;
    }),
    forModule: vi.fn(),
  } satisfies DeviceRuntimeProvider;
  return { provider, runtime, tools, snapshot, emit: () => snapshotListener?.(snapshot) };
}

describe('DeviceRuntimeModuleBinding', () => {
  it('coalesces startup, binds the module once, and fans out one snapshot subscription', async () => {
    const harness = runtimeHarness();
    const binding = new DeviceRuntimeModuleBinding(harness.provider, 'control');
    const listener = vi.fn();
    binding.subscribe(listener);

    const [first, second] = await Promise.all([binding.tools(), binding.tools()]);
    expect(first).toBe(harness.tools);
    expect(second).toBe(harness.tools);
    expect(harness.provider.start).toHaveBeenCalledTimes(1);
    expect(harness.runtime.forModule).toHaveBeenCalledOnce();
    expect(harness.runtime.forModule).toHaveBeenCalledWith('control');
    expect(harness.runtime.manager.subscribe).toHaveBeenCalledOnce();
    harness.emit();
    expect(listener).toHaveBeenLastCalledWith(harness.snapshot);
  });

  it('rejects work after disposal', async () => {
    const harness = runtimeHarness();
    const binding = new DeviceRuntimeModuleBinding(harness.provider, 'voice');
    binding.dispose();
    await expect(binding.tools()).rejects.toThrow(/disposed/);
  });
});

describe('createDeviceInteractionId', () => {
  it('creates a non-empty bounded id with its trusted scope and action', () => {
    const id = createDeviceInteractionId('control-human', 'scan');
    expect(id).toMatch(/^control-human\/scan\//);
    expect(id.length).toBeLessThanOrEqual(128);
  });
});
