import { describe, expect, it } from 'vitest';
import * as protocol from './index.js';

/**
 * Guards against the exact bug this test was added for: OPOSSUM_VIBRATION_PATTERNS
 * was added to opossum.ts but never re-exported from index.js, so every
 * downstream consumer (DG-Agent, DG-Chat) importing from "@dg-kit/protocol"
 * couldn't actually reach it despite it being a documented public API.
 */
describe('package public API surface', () => {
  it('re-exports OPOSSUM_VIBRATION_PATTERNS from the package root', () => {
    expect(protocol.OPOSSUM_VIBRATION_PATTERNS).toBeDefined();
    expect(Object.keys(protocol.OPOSSUM_VIBRATION_PATTERNS)).toEqual(
      expect.arrayContaining(['constant', 'pulse', 'wave', 'ramp', 'heartbeat']),
    );
  });

  it('re-exports OpossumVibrateAdapter and createEmptyOpossumState from the package root', () => {
    expect(protocol.OpossumVibrateAdapter).toBeDefined();
    expect(protocol.createEmptyOpossumState).toBeDefined();
  });
});
