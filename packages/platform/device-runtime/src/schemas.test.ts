import { describe, expect, it } from 'vitest';
import {
  DEVICE_RUNTIME_SCHEMA_VERSION,
  MAX_OUTPUT_LEASE_MS,
  type BackendSessionId,
} from './contracts.js';
import {
  DeviceSchemaError,
  parseBackendEvent,
  parseRuntimeCommand,
  parseRuntimeEvent,
} from './schemas.js';

const fence = {
  sessionId: 'session' as BackendSessionId,
  topologyGeneration: 1,
  safetyGeneration: 2,
  moduleId: 'agent',
  leaseEpoch: 3,
};

function vibrate(over: Record<string, unknown> = {}) {
  return {
    version: DEVICE_RUNTIME_SCHEMA_VERSION,
    type: 'vibrate',
    interactionId: 'turn-1',
    ...fence,
    deviceId: 'device',
    featureId: 'feature',
    intensity: 0.5,
    outputLeaseMs: 1_000,
    ...over,
  };
}

describe('strict runtime schemas', () => {
  it('accepts only the target exceptions defined by the command union', () => {
    expect(
      parseRuntimeCommand({
        version: 1,
        type: 'scan',
        interactionId: 'scan',
        ...fence,
      }).type,
    ).toBe('scan');
    expect(
      parseRuntimeCommand({
        version: 1,
        type: 'disconnect',
        interactionId: 'disconnect',
        ...fence,
        deviceId: 'device',
      }).type,
    ).toBe('disconnect');
    expect(
      parseRuntimeCommand({
        version: 1,
        type: 'emergency-stop',
        interactionId: 'stop-all',
      }).type,
    ).toBe('emergency-stop');
    expect(() => parseRuntimeCommand({ ...vibrate(), featureId: undefined })).toThrow(
      DeviceSchemaError,
    );
  });

  it.each([
    ['unknown field', vibrate({ raw: [1, 2, 3] })],
    ['Raw command', { ...vibrate(), type: 'Raw' }],
    ['unknown command', { ...vibrate(), type: 'rotate' }],
    ['future version', vibrate({ version: 2 })],
    ['NaN intensity', vibrate({ intensity: Number.NaN })],
    ['negative intensity', vibrate({ intensity: -0.01 })],
    ['over-range intensity', vibrate({ intensity: 1.01 })],
    ['fractional lease', vibrate({ outputLeaseMs: 10.5 })],
    ['long lease', vibrate({ outputLeaseMs: MAX_OUTPUT_LEASE_MS + 1 })],
    ['negative generation', vibrate({ safetyGeneration: -1 })],
    ['empty interaction', vibrate({ interactionId: '' })],
  ])('rejects malformed command: %s', (_label, input) => {
    expect(() => parseRuntimeCommand(input)).toThrow(DeviceSchemaError);
  });

  it.each(['raw', 'Raw', 'rotate', 'linear'])('cannot express backend capability %s', (kind) => {
    expect(() =>
      parseBackendEvent({
        version: 1,
        type: 'topology',
        devices: [
          {
            nativeDeviceId: 'native',
            name: 'device',
            capabilities: [{ kind, nativeFeatureId: 'feature', value: 1 }],
          },
        ],
      }),
    ).toThrow(DeviceSchemaError);
  });

  it('rejects unknown nested backend fields and invalid sensor ranges', () => {
    expect(() =>
      parseBackendEvent({
        version: 1,
        type: 'topology',
        devices: [
          {
            nativeDeviceId: 'native',
            name: 'device',
            capabilities: [{ kind: 'battery', nativeFeatureId: 'battery', value: 0.5, raw: true }],
          },
        ],
      }),
    ).toThrow(/unknown field/);
    expect(() =>
      parseBackendEvent({
        version: 1,
        type: 'topology',
        devices: [
          {
            nativeDeviceId: 'native',
            name: 'device',
            capabilities: [{ kind: 'rssi', nativeFeatureId: 'rssi', value: 21 }],
          },
        ],
      }),
    ).toThrow(/-127\.\.20/);
  });

  it('requires acknowledgements to admit that hardware state is unknown', () => {
    const ack = {
      version: 1,
      type: 'ack',
      interactionId: 'turn',
      status: 'applied',
      code: 'write-accepted',
      hardwareState: 'unknown',
      sessionId: 'session',
      topologyGeneration: 1,
      safetyGeneration: 1,
      appliedIntensity: 0.4,
    };
    expect(parseRuntimeEvent(ack)).toEqual(ack);
    expect(() => parseRuntimeEvent({ ...ack, hardwareState: 'vibrating' })).toThrow(
      DeviceSchemaError,
    );
    expect(() => parseRuntimeEvent({ ...ack, nativeState: true })).toThrow(DeviceSchemaError);
  });
});
