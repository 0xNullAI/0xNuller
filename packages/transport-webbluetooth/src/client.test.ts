import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebBluetoothDeviceClient, type ReconnectState } from './client.js';

class FakeGatt {
  connected = false;
  connect = vi.fn<() => Promise<this>>(async () => {
    this.connected = true;
    return this;
  });
  disconnect = vi.fn(() => {
    this.connected = false;
  });
}

class FakeBluetoothDevice extends EventTarget {
  gatt: FakeGatt = new FakeGatt();
  name = 'mock-coyote';

  triggerDisconnect(): void {
    this.gatt.connected = false;
    this.dispatchEvent(new Event('gattserverdisconnected'));
  }
}

class FakeBluetooth {
  device = new FakeBluetoothDevice();
  requestDevice = vi.fn(async () => this.device);
}

class FakeNavigator {
  bluetooth = new FakeBluetooth();
}

class FakeProtocol {
  onConnected = vi.fn(async (_ctx: { device: unknown; server: unknown }) => undefined);
  onDisconnected = vi.fn(async () => undefined);
  emergencyStop = vi.fn(async () => undefined);
  execute = vi.fn(async () => ({ ok: true }));
  getState = vi.fn(() => ({ connected: this.onConnected.mock.calls.length > 0 }));
  subscribe(_listener: (state: unknown) => void): () => void {
    return () => undefined;
  }
}

function setup(): {
  nav: FakeNavigator;
  device: FakeBluetoothDevice;
  protocol: FakeProtocol;
  reconnectStates: ReconnectState[];
} {
  const nav = new FakeNavigator();
  const protocol = new FakeProtocol();
  const reconnectStates: ReconnectState[] = [];
  return {
    nav,
    device: nav.bluetooth.device,
    protocol,
    reconnectStates,
  };
}

describe('WebBluetoothDeviceClient auto-reconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('without autoReconnect, a passive disconnect clears the device and does not retry', async () => {
    const { nav, device, protocol } = setup();
    const client = new WebBluetoothDeviceClient({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      protocol: protocol as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      navigatorRef: nav as any,
    });

    await client.connect();
    expect(protocol.onConnected).toHaveBeenCalledTimes(1);

    device.triggerDisconnect();
    await vi.runAllTimersAsync();

    expect(protocol.onDisconnected).toHaveBeenCalledTimes(1);
    expect(protocol.onConnected).toHaveBeenCalledTimes(1);
    expect(device.gatt.connect).toHaveBeenCalledTimes(1); // initial only
  });

  it('with autoReconnect, silently reconnects on passive disconnect using the cached device', async () => {
    const { nav, device, protocol, reconnectStates } = setup();
    const client = new WebBluetoothDeviceClient({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      protocol: protocol as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      navigatorRef: nav as any,
      autoReconnect: true,
      reconnectBackoffMs: [100],
      onReconnectStateChange: (s) => reconnectStates.push(s),
    });

    await client.connect();
    expect(nav.bluetooth.requestDevice).toHaveBeenCalledTimes(1);

    device.triggerDisconnect();
    await vi.advanceTimersByTimeAsync(150);

    expect(reconnectStates).toEqual(['reconnecting', 'reconnected']);
    expect(protocol.onConnected).toHaveBeenCalledTimes(2);
    // Reconnect must not prompt the user again.
    expect(nav.bluetooth.requestDevice).toHaveBeenCalledTimes(1);
  });

  it('after exhausting attempts, emits failed and drops the cached device', async () => {
    const { nav, device, protocol, reconnectStates } = setup();
    // Make every reconnect throw.
    device.gatt.connect = vi.fn<() => Promise<FakeGatt>>(async () => {
      throw new Error('connect refused');
    });

    const client = new WebBluetoothDeviceClient({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      protocol: protocol as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      navigatorRef: nav as any,
      autoReconnect: true,
      reconnectAttempts: 2,
      reconnectBackoffMs: [10, 10],
      onReconnectStateChange: (s) => reconnectStates.push(s),
    });

    // First connect manually (real connect path); restore working connect.
    device.gatt.connect = vi.fn<() => Promise<FakeGatt>>(async () => {
      device.gatt.connected = true;
      return device.gatt;
    });
    await client.connect();

    // Now break it.
    device.gatt.connect = vi.fn<() => Promise<FakeGatt>>(async () => {
      throw new Error('connect refused');
    });
    device.gatt.connected = false;
    device.triggerDisconnect();

    await vi.advanceTimersByTimeAsync(500);

    expect(reconnectStates).toEqual(['reconnecting', 'reconnecting', 'failed']);
  });

  it('manual disconnect cancels any in-flight reconnect', async () => {
    const { nav, device, protocol, reconnectStates } = setup();
    // Hold the first reconnect attempt open so we can interrupt it mid-flight.
    let resolveReconnect: (() => void) | undefined;
    const initialConnect = device.gatt.connect;
    device.gatt.connect = vi.fn<() => Promise<FakeGatt>>(async () => {
      if (initialConnect.mock.calls.length === 0) {
        // First call (the initial connect) goes through immediately.
        return initialConnect();
      }
      return new Promise<FakeGatt>((resolve) => {
        resolveReconnect = () => resolve(device.gatt);
      });
    });

    const client = new WebBluetoothDeviceClient({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      protocol: protocol as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      navigatorRef: nav as any,
      autoReconnect: true,
      reconnectBackoffMs: [50],
      onReconnectStateChange: (s) => reconnectStates.push(s),
    });

    await client.connect();
    device.triggerDisconnect();
    // Let onDisconnected schedule the reconnect timer.
    await vi.advanceTimersByTimeAsync(60);
    expect(reconnectStates).toEqual(['reconnecting']);

    // Manual disconnect while the reconnect's gatt.connect is still pending.
    await client.disconnect();
    resolveReconnect?.();
    await vi.advanceTimersByTimeAsync(500);

    // 'reconnected' must not be appended after manual disconnect, even if
    // the in-flight gatt.connect resolves later.
    expect(reconnectStates).toEqual(['reconnecting']);
    expect(protocol.onConnected).toHaveBeenCalledTimes(1);
  });
});
