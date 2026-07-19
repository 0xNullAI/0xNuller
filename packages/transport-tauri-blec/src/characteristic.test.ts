import { describe, expect, it, vi } from 'vitest';
import { PluginBlecCharacteristic } from './characteristic.js';
import { makeApi } from './test-utils.js';

describe('PluginBlecCharacteristic', () => {
  it('writeValueWithoutResponse forwards bytes as number[] to plugin-blec.send, scoped to its address', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const api = makeApi({ send });
    const ch = new PluginBlecCharacteristic('char-uuid', api, 'svc-uuid', 'AA:BB:CC');
    await ch.writeValueWithoutResponse(new Uint8Array([1, 2, 3]));
    expect(send).toHaveBeenCalledWith(
      'char-uuid',
      [1, 2, 3],
      'withoutResponse',
      'svc-uuid',
      'AA:BB:CC',
    );
  });

  it('writeValue defaults to withResponse', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const api = makeApi({ send });
    const ch = new PluginBlecCharacteristic('char-uuid', api, 'svc-uuid', 'AA:BB:CC');
    await ch.writeValue(new Uint8Array([9]));
    expect(send).toHaveBeenCalledWith('char-uuid', [9], 'withResponse', 'svc-uuid', 'AA:BB:CC');
  });

  it('readValue stores DataView on .value and returns it, scoped to its address', async () => {
    const read = vi.fn().mockResolvedValue([0x42]);
    const api = makeApi({ read });
    const ch = new PluginBlecCharacteristic('char-uuid', api, 'svc-uuid', 'AA:BB:CC');
    const view = await ch.readValue();
    expect(view.getUint8(0)).toBe(0x42);
    expect(ch.value?.getUint8(0)).toBe(0x42);
    expect(read).toHaveBeenCalledWith('char-uuid', 'svc-uuid', 'AA:BB:CC');
  });

  it('startNotifications subscribes (scoped to service + address) and dispatches events', async () => {
    let captured: ((bytes: number[]) => void) | null = null;
    const subscribe = vi
      .fn()
      .mockImplementation(
        async (_uuid: string, _service: string | null, handler: (b: number[]) => void) => {
          captured = handler;
        },
      );
    const api = makeApi({ subscribe });
    const ch = new PluginBlecCharacteristic('char-uuid', api, 'svc-uuid', 'AA:BB:CC');
    let received: number | null = null;
    ch.addEventListener('characteristicvaluechanged', () => {
      received = ch.value?.getUint8(0) ?? null;
    });
    await ch.startNotifications();
    expect(subscribe).toHaveBeenCalledWith(
      'char-uuid',
      'svc-uuid',
      expect.any(Function),
      'AA:BB:CC',
    );
    expect(captured).not.toBeNull();
    captured!([0xab]);
    expect(received).toBe(0xab);
  });

  it('stopNotifications unsubscribes (scoped to service + address) and is idempotent', async () => {
    const unsubscribe = vi.fn().mockResolvedValue(undefined);
    const api = makeApi({ unsubscribe });
    const ch = new PluginBlecCharacteristic('char-uuid', api, 'svc-uuid', 'AA:BB:CC');
    await ch.startNotifications();
    await ch.stopNotifications();
    await ch.stopNotifications();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledWith('char-uuid', 'svc-uuid', 'AA:BB:CC');
  });

  it('two characteristics for different addresses never mix up which device they write to', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const api = makeApi({ send });
    const chA = new PluginBlecCharacteristic('char-uuid', api, 'svc-uuid', 'AA:AA:AA');
    const chB = new PluginBlecCharacteristic('char-uuid', api, 'svc-uuid', 'BB:BB:BB');

    await chA.writeValue(new Uint8Array([1]));
    await chB.writeValue(new Uint8Array([2]));

    expect(send).toHaveBeenNthCalledWith(
      1,
      'char-uuid',
      [1],
      'withResponse',
      'svc-uuid',
      'AA:AA:AA',
    );
    expect(send).toHaveBeenNthCalledWith(
      2,
      'char-uuid',
      [2],
      'withResponse',
      'svc-uuid',
      'BB:BB:BB',
    );
  });
});
