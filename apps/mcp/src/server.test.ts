import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CivetPressureSensorAdapter,
  CoyoteProtocolAdapter,
  OpossumVibrateAdapter,
  PawPrintsSensorAdapter,
  V3_DEVICE_NAME_PREFIX,
  type BluetoothDeviceLike,
  type BluetoothRemoteGATTCharacteristicLike,
  type WebBluetoothConnectionContext,
} from '@dg-kit/protocol';
import type { Peripheral } from '@stoprocent/noble';
import { createDgMcpServer } from './server.js';
import { DeviceManager, type ConnectedDevice } from './device-manager.js';
import { NodeWaveformLibrary } from './waveform-library.js';
import { DG_MCP_VERSION } from './version.js';

// --- Fake GATT context (no noble involved) ----------------------------------
//
// device-manager.test.ts already exercises the noble/scan/connect plumbing
// end-to-end. These tests are about tool-dispatch logic in server.ts (which
// device gets targeted, how opossum commands are composed, how
// set_indicator_color branches per device kind), so devices are seeded
// directly into a real `DeviceManager`'s internal map via a minimal fake GATT
// context that satisfies `@dg-kit/protocol`'s adapters generically.

class FakeGattCharacteristic extends EventTarget implements BluetoothRemoteGATTCharacteristicLike {
  value: DataView | null = null;
  readonly writes: Uint8Array[] = [];

  async writeValueWithoutResponse(value: ArrayBufferView | ArrayBuffer): Promise<void> {
    this.writes.push(toBytes(value));
  }

  async writeValueWithResponse(value: ArrayBufferView | ArrayBuffer): Promise<void> {
    this.writes.push(toBytes(value));
  }

  async readValue(): Promise<DataView> {
    return new DataView(new ArrayBuffer(1));
  }

  async startNotifications(): Promise<BluetoothRemoteGATTCharacteristicLike> {
    return this;
  }

  async stopNotifications(): Promise<BluetoothRemoteGATTCharacteristicLike> {
    return this;
  }
}

function toBytes(value: ArrayBufferView | ArrayBuffer): Uint8Array {
  return value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function createFakeContext(
  address: string,
  name: string,
): { context: WebBluetoothConnectionContext; charsByUuid: Map<string, FakeGattCharacteristic> } {
  const charsByUuid = new Map<string, FakeGattCharacteristic>();
  const getChar = (uuid: string): FakeGattCharacteristic => {
    let existing = charsByUuid.get(uuid);
    if (!existing) {
      existing = new FakeGattCharacteristic();
      charsByUuid.set(uuid, existing);
    }
    return existing;
  };

  const server = {
    connected: true,
    async getPrimaryService(_uuid: string) {
      return {
        async getCharacteristic(charUuid: string) {
          return getChar(charUuid);
        },
      };
    },
  };

  const device = { id: address, name } as unknown as BluetoothDeviceLike;

  return {
    context: { device, server: server as WebBluetoothConnectionContext['server'] },
    charsByUuid,
  };
}

/** Seeds a connected device straight into a real `DeviceManager`'s map, bypassing noble. */
async function injectConnectedDevice(
  manager: DeviceManager,
  kind: ConnectedDevice['kind'],
  address: string,
): Promise<{ entry: ConnectedDevice; charsByUuid: Map<string, FakeGattCharacteristic> }> {
  // CoyoteProtocolAdapter routes through detectDeviceKind() and rejects
  // names it can't classify (see facade.ts), so the fake device name must
  // carry a real prefix for the kind under test — a plain `fake-${kind}`
  // string only worked before that validation was added.
  const fakeName = kind === 'coyote' ? `${V3_DEVICE_NAME_PREFIX}000` : `fake-${kind}`;
  const { context, charsByUuid } = createFakeContext(address, fakeName);
  const peripheral = { disconnectAsync: async () => undefined } as unknown as Peripheral;

  let entry: ConnectedDevice;
  switch (kind) {
    case 'coyote': {
      const adapter = new CoyoteProtocolAdapter();
      await adapter.onConnected(context);
      entry = { kind: 'coyote', address, peripheral, adapter };
      break;
    }
    case 'paw-prints': {
      const adapter = new PawPrintsSensorAdapter();
      await adapter.onConnected(context);
      entry = { kind: 'paw-prints', address, peripheral, adapter };
      break;
    }
    case 'civet-edging': {
      const adapter = new CivetPressureSensorAdapter();
      await adapter.onConnected(context);
      entry = { kind: 'civet-edging', address, peripheral, adapter };
      break;
    }
    case 'opossum': {
      const adapter = new OpossumVibrateAdapter();
      await adapter.onConnected(context);
      entry = { kind: 'opossum', address, peripheral, adapter };
      break;
    }
  }

  (manager as unknown as { devices: Map<string, ConnectedDevice> }).devices.set(
    address.toLowerCase(),
    entry,
  );

  // onConnected() runs the shared 47L12x-family connect handshake (an init
  // packet write, on the same write characteristic real commands use)
  // before returning. Callers assert on "the write this tool call produced"
  // by index, so clear handshake writes here rather than making every
  // assertion account for a leading handshake packet.
  for (const characteristic of charsByUuid.values()) {
    characteristic.writes.length = 0;
  }
  return { entry, charsByUuid };
}

interface TestHarness {
  client: Client;
  server: Server;
  deviceManager: DeviceManager;
}

async function createHarness(): Promise<TestHarness> {
  const deviceManager = new DeviceManager();
  const waveformLibrary = new NodeWaveformLibrary();
  await waveformLibrary.init();
  const server = createDgMcpServer({ deviceManager, waveformLibrary });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return { client, server, deviceManager };
}

function parseToolResult(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text: string }>;
  const first = content[0];
  if (!first || first.type !== 'text') {
    throw new Error('expected a text content block');
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

describe('server metadata', () => {
  it('reports the version from the package manifest', async () => {
    const { client } = await createHarness();

    expect(client.getServerVersion()).toEqual({ name: 'dg-mcp', version: DG_MCP_VERSION });
  });
});

describe('opossum tool dispatch (plan.type === "opossum")', () => {
  it('vibrate_start sets the requested channel and leaves the other unchanged', async () => {
    const { client, deviceManager } = await createHarness();
    const { entry } = await injectConnectedDevice(deviceManager, 'opossum', 'F1:F1:F1:F1:F1:01');

    const result = await client.callTool({
      name: 'vibrate_start',
      arguments: { channel: 'A', intensity: 15 },
    });

    expect(result.isError).toBeFalsy();
    const adapter = entry.kind === 'opossum' ? entry.adapter : null;
    expect(adapter?.getState().intensityA).toBe(15);
    expect(adapter?.getState().intensityB).toBe(0);
  });

  it('vibrate_stop with no channel zeroes both channels', async () => {
    const { client, deviceManager } = await createHarness();
    const { entry } = await injectConnectedDevice(deviceManager, 'opossum', 'F1:F1:F1:F1:F1:02');
    if (entry.kind === 'opossum') await entry.adapter.setIntensity(50, 60);

    const result = await client.callTool({ name: 'vibrate_stop', arguments: {} });

    expect(result.isError).toBeFalsy();
    const adapter = entry.kind === 'opossum' ? entry.adapter : null;
    expect(adapter?.getState().intensityA).toBe(0);
    expect(adapter?.getState().intensityB).toBe(0);
  });

  it('vibrate_stop with a channel only zeroes that channel', async () => {
    const { client, deviceManager } = await createHarness();
    const { entry } = await injectConnectedDevice(deviceManager, 'opossum', 'F1:F1:F1:F1:F1:03');
    if (entry.kind === 'opossum') await entry.adapter.setIntensity(50, 60);

    const result = await client.callTool({ name: 'vibrate_stop', arguments: { channel: 'A' } });

    expect(result.isError).toBeFalsy();
    const adapter = entry.kind === 'opossum' ? entry.adapter : null;
    expect(adapter?.getState().intensityA).toBe(0);
    expect(adapter?.getState().intensityB).toBe(60);
  });

  it('vibrate_adjust composes getState() + setIntensity() since the adapter has no relative-adjust method', async () => {
    const { client, deviceManager } = await createHarness();
    const { entry } = await injectConnectedDevice(deviceManager, 'opossum', 'F1:F1:F1:F1:F1:04');
    if (entry.kind === 'opossum') await entry.adapter.setIntensity(50, 50);

    const result = await client.callTool({
      name: 'vibrate_adjust',
      arguments: { channel: 'A', delta: 10 },
    });

    expect(result.isError).toBeFalsy();
    const adapter = entry.kind === 'opossum' ? entry.adapter : null;
    expect(adapter?.getState().intensityA).toBe(60);
    expect(adapter?.getState().intensityB).toBe(50);
  });

  it('vibrate_start with a pattern sets both intensity and the vibration pattern', async () => {
    const { client, deviceManager } = await createHarness();
    const { entry } = await injectConnectedDevice(deviceManager, 'opossum', 'F1:F1:F1:F1:F1:05');

    const result = await client.callTool({
      name: 'vibrate_start',
      arguments: { channel: 'A', intensity: 20, pattern: 'pulse' },
    });

    expect(result.isError).toBeFalsy();
    const adapter = entry.kind === 'opossum' ? entry.adapter : null;
    expect(adapter?.getState().intensityA).toBe(20);
    expect(adapter?.getState().patternA).toBe('pulse');
  });

  it('vibrate_change_pattern maps to setVibrationPattern without touching intensity — this is the tool @dg-kit/tools@1.10.0 added and DG-MCP@1.0.x could list but never execute', async () => {
    const { client, deviceManager } = await createHarness();
    const { entry } = await injectConnectedDevice(deviceManager, 'opossum', 'F1:F1:F1:F1:F1:06');
    if (entry.kind === 'opossum') await entry.adapter.setIntensity(40, 'unchanged');

    const result = await client.callTool({
      name: 'vibrate_change_pattern',
      arguments: { channel: 'A', pattern: 'heartbeat' },
    });

    expect(result.isError).toBeFalsy();
    const adapter = entry.kind === 'opossum' ? entry.adapter : null;
    expect(adapter?.getState().patternA).toBe('heartbeat');
    expect(adapter?.getState().intensityA).toBe(40);
  });

  it('vibrate_burst raises the channel then restores after durationMs — also added in @dg-kit/tools@1.10.0 and previously unexecuted', async () => {
    vi.useFakeTimers();
    try {
      const { client, deviceManager } = await createHarness();
      const { entry } = await injectConnectedDevice(deviceManager, 'opossum', 'F1:F1:F1:F1:F1:07');
      if (entry.kind === 'opossum') await entry.adapter.setIntensity(30, 'unchanged');

      const result = await client.callTool({
        name: 'vibrate_burst',
        arguments: { channel: 'A', intensity: 100, durationMs: 500 },
      });

      expect(result.isError).toBeFalsy();
      const adapter = entry.kind === 'opossum' ? entry.adapter : null;
      expect(adapter?.getState().intensityA).toBe(100);

      await vi.advanceTimersByTimeAsync(500);
      expect(adapter?.getState().intensityA).toBe(30);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns a clear Chinese error when no opossum device is connected', async () => {
    const { client } = await createHarness();

    const result = await client.callTool({
      name: 'vibrate_start',
      arguments: { channel: 'A', intensity: 10 },
    });

    expect(result.isError).toBe(true);
    const payload = parseToolResult(result);
    expect(payload.reason).toContain('没有已连接的负鼠设备');
  });

  it('returns a clear error when more than one opossum device is connected', async () => {
    const { client, deviceManager } = await createHarness();
    await injectConnectedDevice(deviceManager, 'opossum', 'F2:F2:F2:F2:F2:01');
    await injectConnectedDevice(deviceManager, 'opossum', 'F2:F2:F2:F2:F2:02');

    const result = await client.callTool({
      name: 'vibrate_start',
      arguments: { channel: 'A', intensity: 10 },
    });

    expect(result.isError).toBe(true);
    const payload = parseToolResult(result);
    expect(payload.reason).toContain('台已连接的负鼠设备');
  });
});

describe('coyote "device" tool dispatch (plan.type === "device")', () => {
  it('start targets the single connected coyote device', async () => {
    const { client, deviceManager } = await createHarness();
    const { entry } = await injectConnectedDevice(deviceManager, 'coyote', 'F3:F3:F3:F3:F3:01');

    const result = await client.callTool({
      name: 'start',
      arguments: { channel: 'A', strength: 5, waveformId: 'pulse_mid' },
    });

    expect(result.isError).toBeFalsy();
    const adapter = entry.kind === 'coyote' ? entry.adapter : null;
    expect(adapter?.getState().strengthA).toBe(5);
  });

  it('shock_start (post-1.9.0 name) targets the single connected coyote device', async () => {
    const { client, deviceManager } = await createHarness();
    const { entry } = await injectConnectedDevice(deviceManager, 'coyote', 'F3:F3:F3:F3:F3:02');

    const result = await client.callTool({
      name: 'shock_start',
      arguments: { channel: 'A', strength: 5, waveformId: 'pulse_mid' },
    });

    expect(result.isError).toBeFalsy();
    const adapter = entry.kind === 'coyote' ? entry.adapter : null;
    expect(adapter?.getState().strengthA).toBe(5);
  });

  it('returns a clear error when no coyote device is connected', async () => {
    const { client } = await createHarness();

    const result = await client.callTool({
      name: 'start',
      arguments: { channel: 'A', strength: 5, waveformId: 'pulse_mid' },
    });

    expect(result.isError).toBe(true);
    const payload = parseToolResult(result);
    expect(payload.reason).toContain('没有已连接的郊狼设备');
  });
});

describe('rate-limit caps track post-1.9.0 tool names', () => {
  it('shock_adjust is capped at 2 calls per window — the caps table used to key on the pre-rename "adjust_strength" and silently stop limiting anything', async () => {
    const { client, deviceManager } = await createHarness();
    await injectConnectedDevice(deviceManager, 'coyote', 'F9:F9:F9:F9:F9:01');

    const args = { channel: 'A', delta: 5 };
    const first = await client.callTool({ name: 'shock_adjust', arguments: args });
    const second = await client.callTool({ name: 'shock_adjust', arguments: args });
    const third = await client.callTool({ name: 'shock_adjust', arguments: args });

    expect(first.isError).toBeFalsy();
    expect(second.isError).toBeFalsy();
    expect(third.isError).toBe(true);
    const payload = parseToolResult(third);
    expect(payload.reason).toContain('上限');
  });

  it('vibrate_burst is capped at 1 call per window', async () => {
    const { client, deviceManager } = await createHarness();
    await injectConnectedDevice(deviceManager, 'opossum', 'F9:F9:F9:F9:F9:02');

    const args = { channel: 'A', intensity: 50, durationMs: 200 };
    const first = await client.callTool({ name: 'vibrate_burst', arguments: args });
    const second = await client.callTool({ name: 'vibrate_burst', arguments: args });

    expect(first.isError).toBeFalsy();
    expect(second.isError).toBe(true);
    const payload = parseToolResult(second);
    expect(payload.reason).toContain('上限');
  });
});

describe('set_indicator_color tool dispatch (plan.type === "setIndicatorColor")', () => {
  it('sends the LED-solid command to a paw-prints device', async () => {
    const { client, deviceManager } = await createHarness();
    const { charsByUuid } = await injectConnectedDevice(
      deviceManager,
      'paw-prints',
      'F4:F4:F4:F4:F4:01',
    );

    const result = await client.callTool({
      name: 'set_indicator_color',
      arguments: { deviceKind: 'paw-prints', color: 3 },
    });

    expect(result.isError).toBeFalsy();
    const payload = parseToolResult(result);
    expect(payload.ok).toBe(true);

    const writeChar = [...charsByUuid.values()].find((c) => c.writes.length > 0);
    expect(writeChar?.writes[0]?.[0]).toBe(0x70); // CMD_LED_CONTROL
    expect(writeChar?.writes[0]?.[1]).toBe(3);
  });

  it('sends the LED command to an opossum device, defaulting button-reporting to enabled', async () => {
    const { client, deviceManager } = await createHarness();
    const { charsByUuid } = await injectConnectedDevice(
      deviceManager,
      'opossum',
      'F4:F4:F4:F4:F4:02',
    );

    const result = await client.callTool({
      name: 'set_indicator_color',
      arguments: { deviceKind: 'opossum', color: 5 },
    });

    expect(result.isError).toBeFalsy();
    const writeChar = [...charsByUuid.values()].find((c) => c.writes.length > 0);
    expect(writeChar?.writes[0]?.[0]).toBe(0x50); // LED color + button-reporting toggle
    expect(writeChar?.writes[0]?.[1]).toBe(5);
    expect(writeChar?.writes[0]?.[2]).toBe(0x01);
  });

  it('sends the LED color via the 0x50 pressure-reporting packet for civet-edging, preserving streaming state', async () => {
    const { client, deviceManager } = await createHarness();
    const { charsByUuid } = await injectConnectedDevice(
      deviceManager,
      'civet-edging',
      'F4:F4:F4:F4:F4:03',
    );

    const result = await client.callTool({
      name: 'set_indicator_color',
      arguments: { deviceKind: 'civet-edging', color: 2 },
    });

    expect(result.isError).toBeFalsy();
    const payload = parseToolResult(result);
    expect(payload.ok).toBe(true);

    const writeChar = [...charsByUuid.values()].find((c) => c.writes.length > 0);
    const lastWrite = writeChar?.writes.at(-1);
    expect(lastWrite?.[0]).toBe(0x50);
    expect(lastWrite?.[1]).toBe(2);
  });
});

describe('MCP-only device-management tools', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  it('list_connected_devices reflects the DeviceManager contents', async () => {
    const before = parseToolResult(
      await harness.client.callTool({ name: 'list_connected_devices', arguments: {} }),
    );
    expect(before.devices).toEqual([]);

    await injectConnectedDevice(harness.deviceManager, 'civet-edging', 'F5:F5:F5:F5:F5:01');

    const after = parseToolResult(
      await harness.client.callTool({ name: 'list_connected_devices', arguments: {} }),
    );
    expect(after.devices).toEqual([
      { address: 'F5:F5:F5:F5:F5:01', deviceKind: 'civet-edging', connected: true },
    ]);
  });

  it('get_status returns an array covering every connected device', async () => {
    await injectConnectedDevice(harness.deviceManager, 'opossum', 'F6:F6:F6:F6:F6:01');
    await injectConnectedDevice(harness.deviceManager, 'coyote', 'F6:F6:F6:F6:F6:02');

    const payload = parseToolResult(
      await harness.client.callTool({ name: 'get_status', arguments: {} }),
    );
    const devices = payload.devices as Array<{ deviceKind: string }>;
    expect(devices).toHaveLength(2);
    expect(devices.map((d) => d.deviceKind).sort()).toEqual(['coyote', 'opossum']);
  });

  it('get_sensor_state returns the cached-empty snapshot for a sensor with no readings yet', async () => {
    await injectConnectedDevice(harness.deviceManager, 'civet-edging', 'F7:F7:F7:F7:F7:01');

    const payload = parseToolResult(
      await harness.client.callTool({ name: 'get_sensor_state', arguments: {} }),
    );
    const sensors = payload.sensors as Array<{ latestReading: unknown }>;
    expect(sensors).toHaveLength(1);
    expect(sensors[0]?.latestReading).toBeNull();
  });

  it('emergency_stop zeroes an opossum device', async () => {
    const { entry } = await injectConnectedDevice(
      harness.deviceManager,
      'opossum',
      'F8:F8:F8:F8:F8:01',
    );
    if (entry.kind === 'opossum') await entry.adapter.setIntensity(90, 90);

    const payload = parseToolResult(
      await harness.client.callTool({ name: 'emergency_stop', arguments: {} }),
    );
    expect(payload.ok).toBe(true);

    const adapter = entry.kind === 'opossum' ? entry.adapter : null;
    expect(adapter?.getState().intensityA).toBe(0);
    expect(adapter?.getState().intensityB).toBe(0);
  });
});
