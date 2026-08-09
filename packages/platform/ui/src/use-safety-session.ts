import { useEffect, useRef } from 'react';
import { registerSafetySession, type DeviceSummary } from '@dg-kit/safety';

/**
 * Register a module's device session on the global safety bus.
 *
 * This is the SOLE source that makes the global stop button appear. Before
 * it existed, `registerSafetySession` had zero callers repo-wide and
 * `EmergencyStopButton` always hit `return null` — the button never
 * rendered, while build, tests, and lint were all green. Lesson: before
 * verifying "the button survives switching modules", verify it ever
 * appeared.
 *
 * `isActive` means "does this module hold a connected device", NOT "is it
 * outputting". Deliberate: tying the stop button's visibility to "is
 * outputting" makes it depend on state that can be wrong in many ways
 * (missed subscription update, lease just revoked while the device still
 * runs) — any mistake hides the button at the worst moment. Better to
 * long-show a button that may stop an idle device.
 */

export interface SafetySessionSpec {
  id: string;
  label: string;
  /** Whether this module currently holds a connected device. */
  isActive: () => boolean;
  /** Zero all of this module's device output. Must be idempotent. */
  stop: () => void | Promise<void>;
  /** Devices this module holds, for the shell's device bar. */
  devices?: () => DeviceSummary[];
  /**
   * Called on losing the device lease. Must stop output, clear "held
   * down" aggregate state, and reject subsequent commands. See
   * SafetySession.onRevoke in @dg-kit/safety.
   */
  onRevoke?: () => void | Promise<void>;
}

export function useSafetySession(spec: SafetySessionSpec): void {
  // Callbacks live in a ref: registration happens once per id, but
  // stop/isActive are new functions every render. Putting them in the deps
  // re-registers every frame and fills the Map with closures that go stale
  // immediately.
  const latest = useRef(spec);
  latest.current = spec;

  useEffect(() => {
    return registerSafetySession({
      id: spec.id,
      label: spec.label,
      isActive: () => latest.current.isActive(),
      stop: () => latest.current.stop(),
      devices: () => latest.current.devices?.() ?? [],
      onRevoke: () => latest.current.onRevoke?.(),
    });
  }, [spec.id, spec.label]);
}
