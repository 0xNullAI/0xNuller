import { describe, expect, it, vi } from 'vitest';
import { ButtplugDeviceBackend, type ButtplugNativeBridge } from './buttplug-device-backend';

function initialize() {
  return {
    schemaVersion: 1,
    sessionId: 'native-session',
    topologyGeneration: 0,
    safetyGeneration: 0,
    scanning: false,
  };
}

function operationAck(topologyGeneration = 1, safetyGeneration = 1) {
  return {
    schemaVersion: 1,
    sessionId: 'native-session',
    topologyGeneration,
    safetyGeneration,
    acknowledged: true,
    hardwareState: 'unknown',
  };
}

function globalAck(safetyGeneration = 1) {
  return {
    schemaVersion: 1,
    acknowledged: true,
    hardwareState: 'unknown',
    sessionId: 'native-session',
    topologyGeneration: 1,
    safetyGeneration,
  };
}

function bridgeHarness() {
  let channel: ((message: unknown) => void) | undefined;
  const invoke = vi.fn(async (command: string) => {
    switch (command) {
      case 'experimental_buttplug_initialize':
        return initialize();
      case 'experimental_buttplug_start_scan':
        return { ...initialize(), topologyGeneration: 1, safetyGeneration: 1, scanning: true };
      case 'experimental_buttplug_vibrate':
      case 'experimental_buttplug_stop_feature':
      case 'experimental_buttplug_disconnect':
        return operationAck();
      case 'experimental_buttplug_stop_all':
        return globalAck();
      case 'experimental_buttplug_close':
        return {
          ...globalAck(),
          sessionId: null,
          topologyGeneration: null,
          safetyGeneration: null,
        };
      default:
        throw new Error(`unexpected command ${command}`);
    }
  });
  const bridge: ButtplugNativeBridge = {
    invoke,
    createChannel(onMessage) {
      channel = onMessage as (message: unknown) => void;
      return { channel: 'opaque' };
    },
  };
  return {
    bridge,
    invoke,
    emit(message: unknown) {
      if (!channel) throw new Error('channel not initialized');
      channel(message);
    },
  };
}

function topologyEvent() {
  return {
    schemaVersion: 1,
    type: 'topology',
    sessionId: 'native-session',
    topologyGeneration: 1,
    safetyGeneration: 1,
    devices: [
      {
        nativeDeviceId: 'opaque-device',
        name: 'Connected device',
        capabilities: [
          { kind: 'vibrate', nativeFeatureId: 'vibrate-1', stepCount: 20 },
          { kind: 'battery', nativeFeatureId: 'battery-1', value: 0.42 },
          { kind: 'rssi', nativeFeatureId: 'rssi-1', value: null },
        ],
      },
    ],
  };
}

describe('Buttplug native DeviceBackend adapter', () => {
  it('strictly maps topology without exposing transport identifiers or unsupported capabilities', async () => {
    const harness = bridgeHarness();
    const events: unknown[] = [];
    await new ButtplugDeviceBackend(harness.bridge).openSession((event) => events.push(event));
    harness.emit(topologyEvent());

    expect(events).toEqual([
      {
        version: 1,
        type: 'topology',
        devices: topologyEvent().devices,
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('address');
    expect(JSON.stringify(events)).not.toContain('bytes');
  });

  it('forwards only the exact opaque device and feature pair and keeps stop unfenced', async () => {
    const harness = bridgeHarness();
    const session = await new ButtplugDeviceBackend(harness.bridge).openSession(() => undefined);
    harness.emit(topologyEvent());

    await session.writeVibrate('opaque-device', 'vibrate-1', 0.25);
    await session.stopFeature('opaque-device', 'vibrate-1');

    expect(harness.invoke).toHaveBeenCalledWith('experimental_buttplug_vibrate', {
      request: {
        schemaVersion: 1,
        sessionId: 'native-session',
        topologyGeneration: 1,
        safetyGeneration: 1,
        deviceId: 'opaque-device',
        featureId: 'vibrate-1',
        intensity: 0.25,
      },
    });
    expect(harness.invoke).toHaveBeenCalledWith('experimental_buttplug_stop_feature', {
      request: {
        schemaVersion: 1,
        deviceId: 'opaque-device',
        featureId: 'vibrate-1',
      },
    });
  });

  it('turns unknown native fields and generation regressions into terminal backend loss', async () => {
    const harness = bridgeHarness();
    const events: unknown[] = [];
    const session = await new ButtplugDeviceBackend(harness.bridge).openSession((event) =>
      events.push(event),
    );
    harness.emit({ ...topologyEvent(), raw: [1, 2, 3] });

    expect(events).toEqual([{ version: 1, type: 'session-ended', reason: 'invalid-native-event' }]);
    await expect(session.scan()).rejects.toThrow('buttplug-native-session-ended');
    await vi.waitFor(() => {
      expect(harness.invoke).toHaveBeenCalledWith('experimental_buttplug_stop_all', {
        request: { schemaVersion: 1 },
      });
    });
  });

  it('preserves close stop failures instead of reporting a successful lifecycle stop', async () => {
    const harness = bridgeHarness();
    const stopFailure = { code: 'stop_failed', message: 'hardware state is unknown' };
    harness.invoke.mockImplementation(async (command: string) => {
      if (command === 'experimental_buttplug_initialize') return initialize();
      if (command === 'experimental_buttplug_close') throw stopFailure;
      return globalAck();
    });
    const session = await new ButtplugDeviceBackend(harness.bridge).openSession(() => undefined);

    await expect(session.close()).rejects.toBe(stopFailure);
    await expect(session.close()).rejects.toBe(stopFailure);
    expect(harness.invoke).toHaveBeenCalledTimes(3);
  });

  it('buffers topology delivered during native initialization', async () => {
    const events: unknown[] = [];
    let callback: ((message: unknown) => void) | undefined;
    const bridge: ButtplugNativeBridge = {
      createChannel(onMessage) {
        callback = onMessage as (message: unknown) => void;
        return {};
      },
      async invoke(command) {
        if (command !== 'experimental_buttplug_initialize') throw new Error('unexpected command');
        callback?.(topologyEvent());
        return initialize();
      },
    };

    await new ButtplugDeviceBackend(bridge).openSession((event) => events.push(event));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ version: 1, type: 'topology' });
  });
});
