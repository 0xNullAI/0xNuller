import { afterEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const { armNativeStop, nativeStop, NATIVE_WATCHDOG_MS } = await import('./native-safety.js');

afterEach(() => invoke.mockReset());

describe('native safety floor', () => {
  it('registers the protocol stop packet with a watchdog', async () => {
    invoke.mockResolvedValue(undefined);
    const ok = await armNativeStop('AA:BB', {
      service: 'svc',
      characteristic: 'chr',
      packet: Uint8Array.from([0xb0, 0x0f, 0, 0]),
    });

    expect(ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith('plugin:blec|set_safety_stop', {
      address: 'AA:BB',
      service: 'svc',
      characteristic: 'chr',
      packet: [0xb0, 0x0f, 0, 0],
      watchdogMs: NATIVE_WATCHDOG_MS,
    });
  });

  it('does nothing without an address or a recipe, and tolerates an older plugin', async () => {
    expect(await armNativeStop('', null)).toBe(false);
    expect(await nativeStop(null)).toBe(false);
    expect(invoke).not.toHaveBeenCalled();

    invoke.mockRejectedValue(new Error('unknown command'));
    expect(await nativeStop('AA:BB')).toBe(false);
    expect(invoke).toHaveBeenCalledWith('plugin:blec|safety_stop', { address: 'AA:BB' });
  });
});
