import { describe, expect, it } from 'vitest';
import type { BackendSessionId, DeviceId, FeatureId } from './contracts.js';
import {
  createUnifiedOutputTargets,
  outputTargetSafetyControl,
  resolveUnifiedOutputTarget,
  unifiedOutputIdentity,
} from './output-targets.js';

const safety = {
  maxStrengthA: 30,
  maxStrengthB: 40,
  maxIntensityA: 60,
  maxIntensityB: 80,
};

describe('unified output targets', () => {
  it('combines multiple Coyotes, Opossum and generic capabilities without losing identity', () => {
    const targets = createUnifiedOutputTargets(
      [
        { kind: 'coyote', targetId: 'coyote-a', name: 'Alpha', battery: 88 },
        { kind: 'coyote', targetId: 'coyote-b', name: 'Beta', battery: 77 },
        { kind: 'opossum', targetId: 'opossum-a', name: 'Gamma', battery: 66 },
      ],
      {
        version: 1,
        sessionId: 'session' as BackendSessionId,
        sequence: 1,
        topologyGeneration: 1,
        safetyGeneration: 1,
        devices: [
          {
            deviceId: 'generic-a' as DeviceId,
            name: 'Nimbus',
            capabilities: [
              { kind: 'vibrate', featureId: 'motor-a' as FeatureId, stepCount: 20, faulted: false },
              { kind: 'vibrate', featureId: 'motor-b' as FeatureId, stepCount: 20, faulted: false },
            ],
          },
        ],
      },
    );

    expect(targets.map(({ id, kind, modality }) => ({ id, kind, modality }))).toEqual([
      { id: 'coyote/coyote-a', kind: 'coyote', modality: 'electrostimulation' },
      { id: 'coyote/coyote-b', kind: 'coyote', modality: 'electrostimulation' },
      { id: 'opossum/opossum-a', kind: 'opossum', modality: 'vibration' },
      { id: 'embedded/generic-a/motor-a', kind: 'embedded', modality: 'vibration' },
      { id: 'embedded/generic-a/motor-b', kind: 'embedded', modality: 'vibration' },
    ]);
  });

  it('keeps the selected identity and falls back to the first live target after disconnect', () => {
    const targets = createUnifiedOutputTargets(
      [
        { kind: 'coyote', targetId: 'one', name: 'One' },
        { kind: 'coyote', targetId: 'two', name: 'Two' },
      ],
      null,
    );
    expect(resolveUnifiedOutputTarget(targets, unifiedOutputIdentity('coyote', 'two'))?.id).toBe(
      'coyote/two',
    );
    expect(resolveUnifiedOutputTarget(targets.slice(0, 1), 'coyote/two')?.id).toBe('coyote/one');
    expect(resolveUnifiedOutputTarget([], 'coyote/two')).toBeNull();
  });

  it('derives modality-specific caps only from shared device safety settings', () => {
    const [coyote, opossum] = createUnifiedOutputTargets(
      [
        { kind: 'coyote', targetId: 'one', name: 'One' },
        { kind: 'opossum', targetId: 'two', name: 'Two' },
      ],
      null,
    );
    expect(outputTargetSafetyControl(coyote!, 'B', safety)).toEqual({
      max: 40,
      step: 1,
      normalized: false,
    });
    expect(outputTargetSafetyControl(opossum!, 'B', safety)).toEqual({
      max: 80,
      step: 1,
      normalized: false,
    });
    expect(
      outputTargetSafetyControl(
        {
          id: 'embedded/device/motor',
          kind: 'embedded',
          deviceId: 'device' as DeviceId,
          featureId: 'motor' as FeatureId,
          label: 'Motor',
          modality: 'vibration',
          battery: null,
          active: false,
        },
        'B',
        safety,
      ),
    ).toEqual({ max: 0.3, step: 0.01, normalized: true });
  });
});
