/**
 * Safety bus: keeps "stop" reachable regardless of UI state.
 *
 * Each module registers its own emergency-stop function here, so the shell
 * (or any orchestration layer) can stop *every* registered device session in
 * one place, without knowing which modules exist or how each implements its
 * stop.
 *
 * Why it exists: a module that is switched away from gets hidden (it stays
 * mounted so BLE doesn't drop), which means its own stop button is
 * unreachable while its device is *still outputting*. The shell needs a stop
 * anchor that doesn't come and go with module visibility.
 *
 * Three design constraints:
 * 1. `stopAll` must be best-effort — it must NOT abort because one session
 *    throws. When one module's BLE is already gone and throws, the other
 *    modules' devices are still outputting.
 * 2. The registry is a Map, not an array: on hot reload / remount a module
 *    overwrites its entry by id instead of piling up stale closures —
 *    otherwise stopAll would invoke functions of unmounted modules.
 * 3. No "remember who was outputting last" optimization. Stop is a
 *    low-frequency, high-stakes operation; stopping a few idle devices is
 *    fine, missing one because of a state-tracking bug is not.
 */

/**
 * Summary of one connected device, for the shell's device bar.
 *
 * Lives on the safety bus rather than in a separate registry: the device bar
 * and the stop button are two faces of the same thing — listing devices tells
 * the user what is on their body, and stop must sit right next to that. Two
 * registries could disagree, and the moment they disagree is exactly the
 * dangerous one.
 */
export interface DeviceSummary {
  /** Stable and unique within one module. */
  id: string;
  /** Device kind: coyote / opossum / paw-prints / civet-edging. */
  kind: string;
  /** User-facing name, usually the BLE advertised name. */
  name: string;
  connected: boolean;
  /** Battery percentage; omitted when unknown. */
  battery?: number;
  /** Whether it is currently outputting. Visual emphasis only — NOT used to decide whether the stop button shows. */
  active?: boolean;
  /** Per-channel strength, for the live readout on the device bar. */
  channels?: { label: string; value: number; max: number }[];
  /** Read-only sensor values which have no output limit or stop semantics. */
  readings?: { label?: string; value: number; unit?: string }[];
}

export interface SafetySession {
  /** Module id, used for overwrite-on-register and diagnostics. */
  id: string;
  /** User-facing name, appears in prompts like "outputting: Agent". */
  label: string;
  /**
   * Whether this module currently *holds a connected device*. Note: not
   * "whether it is outputting".
   *
   * Tying the stop anchor's visibility to "is outputting" makes it depend on
   * a state chain that can break at any time (missed subscription update,
   * lease just revoked while the device is still running). One wrong link and
   * the button disappears at exactly the moment it is needed most. Better to
   * long-show a button that may stop an idle device.
   */
  isActive: () => boolean;
  /** Zero all device output of this module. Must be idempotent — may be called repeatedly. */
  stop: () => void | Promise<void>;
  /** Devices this module currently holds. The shell renders the device bar from it. */
  devices?: () => DeviceSummary[];
  /**
   * Open this module's unified device picker. When present, the shell renders
   * the one connect entry in its top device strip; modules must not duplicate
   * the same action inside their content while mounted in the shell.
   */
  connect?: () => void | Promise<unknown>;
  /** Disconnect one device listed by `devices()`. Used by the shell's top strip. */
  disconnect?: (deviceId: string) => void | Promise<unknown>;
  /**
   * Called when the module loses the device lease.
   *
   * It MUST do three things: stop output, clear any "held down" aggregate
   * state, and reject subsequent commands. Doing only the first is not
   * enough — e.g. Chat's fire aggregation snapshots a baseline on the
   * empty-to-nonempty edge; if revocation lands while someone is holding
   * fire, the matching release message never arrives and strength stays at
   * baseline+boost instead of falling back.
   *
   * It must NEVER be implemented as disconnect(). Agent and Voice clients
   * run with autoReconnect; surrendering control by disconnecting lets the
   * background module silently reconnect inside the GATT-disconnect event
   * and steal the device back (the client still caches the BluetoothDevice
   * reference, so reconnecting needs no user gesture) — while the new holder
   * believes it has exclusive control.
   */
  onRevoke?: () => void | Promise<void>;
}

export interface StopAllResult {
  /** Number of sessions a stop was attempted for. */
  attempted: number;
  /** Sessions that threw, with the error. The rest are stopped. */
  failed: { id: string; error: unknown }[];
}

const sessions = new Map<string, SafetySession>();
const listeners = new Set<() => void>();

/**
 * The module currently holding the device lease.
 *
 * `null` means no module holds it — e.g. while sitting on the home screen.
 * Then *no module may issue commands*, but devices stay connected and the
 * stop button stays usable. This matters: surrendering control is not the
 * same as disconnecting.
 */
let leaseHolder: string | null = null;
/**
 * Monotonic fencing token for the module lease. A holder name alone cannot
 * distinguish agent → chat → agent from one uninterrupted agent lease.
 */
let leaseEpoch = 0;

/** Atomic snapshot used by native-write boundaries to reject lease ABA. */
export interface DeviceLeaseSnapshot {
  holder: string | null;
  epoch: number;
}

function notify(): void {
  for (const l of listeners) l();
}

/** Register a module's device session. Returns an unregister function. */
export function registerSafetySession(session: SafetySession): () => void {
  sessions.set(session.id, session);
  notify();
  return () => {
    // Delete only while still ours: after a remount the new session has
    // overwritten the old one, and the old cleanup must not remove the new.
    if (sessions.get(session.id) === session) {
      sessions.delete(session.id);
      notify();
    }
  };
}

/** A registered module session, including its optional shell connect action. */
export function safetySessionById(id: string | null): SafetySession | null {
  return id ? (sessions.get(id) ?? null) : null;
}

/** Modules that currently have an active device session. */
export function activeSafetySessions(): SafetySession[] {
  return [...sessions.values()].filter((s) => {
    try {
      return s.isActive();
    } catch {
      // If the check itself throws, treat as active — better to show one
      // extra stop button than to miss one.
      return true;
    }
  });
}

export function hasActiveSafetySession(): boolean {
  return activeSafetySessions().length > 0;
}

/**
 * All devices currently held, grouped by module.
 *
 * If a module's check throws, skip that module instead of aborting — one
 * module's broken state read must not blank the whole device bar, which
 * would also hide the stop button next to it.
 */
export function allConnectedDevices(): {
  sessionId: string;
  label: string;
  devices: DeviceSummary[];
}[] {
  const out: { sessionId: string; label: string; devices: DeviceSummary[] }[] = [];
  for (const s of sessions.values()) {
    try {
      const devices = s.devices?.().filter((d) => d.connected) ?? [];
      if (devices.length) out.push({ sessionId: s.id, label: s.label, devices });
    } catch {
      // Skip this one; the rest proceed as normal.
    }
  }
  return out;
}

/**
 * Stop every registered session.
 *
 * allSettled, not all: one module throwing must not abort the others' stops
 * — that is exactly the dangerous case (one device throws on a dropped
 * connection while another keeps outputting).
 */
export async function stopAllSafetySessions(): Promise<StopAllResult> {
  const list = [...sessions.values()];
  const results = await Promise.allSettled(
    // The wrapper is required: if stop() throws *synchronously*, the
    // exception escapes inside map and never reaches allSettled — exactly
    // the dangerous case (one device throws on disconnect, none of the
    // others get stopped). The unit test "one session throwing must not
    // abort the others" guards this.
    list.map((s) => Promise.resolve().then(() => s.stop())),
  );
  const failed = results.flatMap((r, i) =>
    r.status === 'rejected' ? [{ id: list[i]!.id, error: r.reason }] : [],
  );
  return { attempted: list.length, failed };
}

/**
 * Hand the device lease to a module. All other modules lose control
 * immediately and are told to stop.
 *
 * Revocation is best-effort: one module's onRevoke throwing must not abort
 * the others' revocation — that is exactly the dangerous case (one module
 * errors while another is still being remotely controlled).
 */
export async function grantDeviceLease(moduleId: string | null): Promise<void> {
  if (leaseHolder === moduleId) return;
  const previous = leaseHolder;
  leaseHolder = moduleId;
  leaseEpoch += 1;
  notify();

  if (!previous) return;
  const losing = sessions.get(previous);
  if (!losing?.onRevoke) return;
  try {
    // `try { await f() }` already catches a synchronous throw — the call
    // itself is inside the try. (stopAllSafetySessions needs the extra
    // wrapper because its call happens inside `map`, outside allSettled —
    // a different situation.)
    await losing.onRevoke();
  } catch {
    // If revocation fails, at least stop it — it no longer holds the lease,
    // but its device may still be outputting.
    try {
      await losing.stop();
    } catch {
      // Both paths failed: the global stop button is still reachable; that
      // is the last line of defense.
    }
  }
}

/**
 * Whether this module currently holds the device lease.
 *
 * Modules check this before *every* device command, not just to disable
 * buttons — remote commands (other room members, AI) never pass through the
 * UI.
 */
export function hasDeviceLease(moduleId: string): boolean {
  return leaseHolder === moduleId;
}

export function currentDeviceLease(): string | null {
  return leaseHolder;
}

/**
 * Read the holder and its fencing epoch atomically.
 *
 * Consumers that perform asynchronous work must capture this snapshot and
 * compare both fields again immediately before reaching a native write.
 */
export function currentDeviceLeaseSnapshot(): DeviceLeaseSnapshot {
  return { holder: leaseHolder, epoch: leaseEpoch };
}

/** Subscribe to registry changes (module mount/unmount, lease transfer). */
export function subscribeSafetySessions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
