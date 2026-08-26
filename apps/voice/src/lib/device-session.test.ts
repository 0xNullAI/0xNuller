import { createEmptyDeviceState, type DeviceState } from '@dg-kit/core';
import { createEmptyOpossumState, type OpossumState } from '@dg-kit/protocol';
import { describe, expect, it, vi } from 'vitest';
import { DeviceSession, type DeviceSessionTransport } from './device-session.js';

function transportHarness(initialCoyoteConnected = false) {
  let coyoteState: DeviceState = {
    ...createEmptyDeviceState(),
    connected: initialCoyoteConnected,
    deviceName: initialCoyoteConnected ? 'Same advertised name' : undefined,
  };
  const opossumState: OpossumState = createEmptyOpossumState();
  let coyoteListener: (state: DeviceState) => void = () => undefined;
  const disconnectPicked = vi.fn();
  const pickedDevice = Object.assign(new EventTarget(), {
    id: 'native-id-hidden-from-model',
    name: 'Same advertised name',
    gatt: { connected: true, connect: vi.fn(), disconnect: disconnectPicked },
  });
  const server = { connected: true, getPrimaryService: vi.fn() };
  const coyote = {
    connect: vi.fn(),
    connectDevice: vi.fn(async () => {
      coyoteState = { ...coyoteState, connected: true, deviceName: 'Same advertised name' };
      coyoteListener(coyoteState);
    }),
    disconnect: vi.fn(async () => {
      coyoteState = { ...coyoteState, connected: false };
      coyoteListener(coyoteState);
    }),
    getState: vi.fn(async () => coyoteState),
    execute: vi.fn(),
    emergencyStop: vi.fn(async () => undefined),
    onStateChanged: vi.fn((listener: (state: DeviceState) => void) => {
      coyoteListener = listener;
      return vi.fn();
    }),
  };
  const opossum = {
    connect: vi.fn(),
    connectDevice: vi.fn(),
    disconnect: vi.fn(),
    getState: vi.fn(async () => opossumState),
    execute: vi.fn(),
    emergencyStop: vi.fn(),
    setIndicatorColor: vi.fn(),
    onStateChanged: vi.fn(() => vi.fn()),
  };
  const transport = {
    coyote,
    opossum,
    requestDevice: vi.fn(async () => ({ kind: 'coyote', device: pickedDevice, server })),
  } as unknown as DeviceSessionTransport;
  return { transport, coyote, opossum, disconnectPicked };
}

describe('Voice legacy device single-instance identity', () => {
  it('rejects a second same-kind device without merging or replacing the connected target', async () => {
    const { transport, coyote, disconnectPicked } = transportHarness(true);
    const session = new DeviceSession(transport);

    await expect(session.connectDevice()).rejects.toThrow('当前只支持一台郊狼');
    expect(coyote.connectDevice).not.toHaveBeenCalled();
    expect(disconnectPicked).toHaveBeenCalledTimes(1);
  });

  it('issues a new opaque identity after disconnect and reconnect even when names match', async () => {
    const { transport } = transportHarness();
    const session = new DeviceSession(transport);

    await session.connectDevice();
    const first = session.currentTargetId('coyote');
    await session.disconnectCoyote();
    expect(session.currentTargetId('coyote')).toBeNull();
    await session.connectDevice();
    const second = session.currentTargetId('coyote');

    expect(first).toMatch(/^voice-coyote\//);
    expect(second).toMatch(/^voice-coyote\//);
    expect(second).not.toBe(first);
    expect(first).not.toContain('Same advertised name');
  });
});
