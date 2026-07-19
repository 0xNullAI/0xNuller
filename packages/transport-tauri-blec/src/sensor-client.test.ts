import { describe, expect, it, vi } from 'vitest';
import { __setPluginBlecForTests, type BleDeviceInfo } from './plugin-blec.js';
import { TauriBlecCivetEdgingClient, TauriBlecPawPrintsClient } from './sensor-client.js';
import { makeApi, makeDevice } from './test-utils.js';

function scanHandlerWith(devices: BleDeviceInfo[]) {
  return vi.fn().mockImplementation(async (handler: (devices: BleDeviceInfo[]) => void) => {
    handler(devices);
  });
}

describe('TauriBlecPawPrintsClient', () => {
  it('connects and reports its address', async () => {
    const api = makeApi({
      startScan: scanHandlerWith([makeDevice({ address: 'PAW-1', name: '47L1200000XX' })]),
    });
    __setPluginBlecForTests(api);

    const client = new TauriBlecPawPrintsClient({
      selectDevice: async (c) => c.initial[0]?.address ?? null,
      scanDurationMs: 50,
      gattReadyInitialDelayMs: 0,
    });
    await client.connect();

    expect(client.address).toBe('PAW-1');
    const state = await client.getState();
    expect(state.connected).toBe(true);
  });

  it('setIndicatorColor forwards to the dedicated LED-solid opcode', async () => {
    const api = makeApi({
      startScan: scanHandlerWith([makeDevice({ address: 'PAW-1', name: '47L1200000XX' })]),
    });
    __setPluginBlecForTests(api);

    const client = new TauriBlecPawPrintsClient({
      selectDevice: async () => 'PAW-1',
      scanDurationMs: 50,
      gattReadyInitialDelayMs: 0,
    });
    await client.connect();
    (api.send as ReturnType<typeof vi.fn>).mockClear();

    await client.setIndicatorColor(5);
    expect(api.send).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.any(String),
      expect.any(String),
      'PAW-1',
    );
  });

  it('disconnect() does not affect a concurrently-connected civet-edging client', async () => {
    const api = makeApi({
      startScan: vi.fn().mockImplementation(async (handler: (devices: BleDeviceInfo[]) => void) => {
        handler([
          makeDevice({ address: 'PAW-1', name: '47L1200000XX' }),
          makeDevice({ address: 'CIVET-1', name: '47L1240000XX' }),
        ]);
      }),
    });
    __setPluginBlecForTests(api);

    const paw = new TauriBlecPawPrintsClient({
      selectDevice: async () => 'PAW-1',
      scanDurationMs: 50,
      gattReadyInitialDelayMs: 0,
    });
    const civet = new TauriBlecCivetEdgingClient({
      selectDevice: async () => 'CIVET-1',
      scanDurationMs: 50,
      gattReadyInitialDelayMs: 0,
    });

    await paw.connect();
    await civet.connect();
    expect(paw.address).toBe('PAW-1');
    expect(civet.address).toBe('CIVET-1');

    await paw.disconnect();

    expect(api.disconnect).toHaveBeenCalledTimes(1);
    expect(api.disconnect).toHaveBeenCalledWith('PAW-1');
    expect(paw.address).toBeNull();
    expect(civet.address).toBe('CIVET-1');
    const civetState = await civet.getState();
    expect(civetState.connected).toBe(true);
  });
});

describe('TauriBlecCivetEdgingClient', () => {
  it('setIndicatorColor re-sends the pressure-reporting packet, not a dedicated LED opcode', async () => {
    const api = makeApi({
      startScan: scanHandlerWith([makeDevice({ address: 'CIVET-1', name: '47L1240000XX' })]),
    });
    __setPluginBlecForTests(api);

    const client = new TauriBlecCivetEdgingClient({
      selectDevice: async () => 'CIVET-1',
      scanDurationMs: 50,
      gattReadyInitialDelayMs: 0,
    });
    await client.connect();

    await expect(client.setIndicatorColor(3)).resolves.toBeUndefined();
  });
});
