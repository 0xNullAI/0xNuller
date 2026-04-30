import { describe, expect, it, vi } from 'vitest';
import { PluginBlecCharacteristic } from './characteristic.js';
import type { PluginBlecApi } from './plugin-blec.js';

function makeApi(overrides: Partial<PluginBlecApi> = {}): PluginBlecApi {
  return {
    checkPermissions: vi.fn().mockResolvedValue(true),
    startScan: vi.fn().mockResolvedValue(undefined),
    stopScan: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockResolvedValue([]),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('PluginBlecCharacteristic', () => {
  it('writeValueWithoutResponse forwards bytes as number[] to plugin-blec.send', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const api = makeApi({ send });
    const ch = new PluginBlecCharacteristic('char-uuid', api, 'svc-uuid');
    await ch.writeValueWithoutResponse(new Uint8Array([1, 2, 3]));
    expect(send).toHaveBeenCalledWith('char-uuid', [1, 2, 3], 'withoutResponse', 'svc-uuid');
  });

  it('writeValue defaults to withResponse', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const api = makeApi({ send });
    const ch = new PluginBlecCharacteristic('char-uuid', api, 'svc-uuid');
    await ch.writeValue(new Uint8Array([9]));
    expect(send).toHaveBeenCalledWith('char-uuid', [9], 'withResponse', 'svc-uuid');
  });

  it('readValue stores DataView on .value and returns it', async () => {
    const read = vi.fn().mockResolvedValue([0x42]);
    const api = makeApi({ read });
    const ch = new PluginBlecCharacteristic('char-uuid', api, 'svc-uuid');
    const view = await ch.readValue();
    expect(view.getUint8(0)).toBe(0x42);
    expect(ch.value?.getUint8(0)).toBe(0x42);
  });

  it('startNotifications subscribes and dispatches events', async () => {
    let captured: ((bytes: number[]) => void) | null = null;
    const subscribe = vi.fn().mockImplementation(
      async (_uuid: string, handler: (b: number[]) => void) => {
        captured = handler;
      },
    );
    const api = makeApi({ subscribe });
    const ch = new PluginBlecCharacteristic('char-uuid', api, 'svc-uuid');
    let received: number | null = null;
    ch.addEventListener('characteristicvaluechanged', () => {
      received = ch.value?.getUint8(0) ?? null;
    });
    await ch.startNotifications();
    expect(captured).not.toBeNull();
    captured!([0xab]);
    expect(received).toBe(0xab);
  });

  it('stopNotifications unsubscribes and is idempotent', async () => {
    const unsubscribe = vi.fn().mockResolvedValue(undefined);
    const api = makeApi({ unsubscribe });
    const ch = new PluginBlecCharacteristic('char-uuid', api, 'svc-uuid');
    await ch.startNotifications();
    await ch.stopNotifications();
    await ch.stopNotifications();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
