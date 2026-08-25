import { activeSafetySessions, allConnectedDevices, stopAllSafetySessions } from '@dg-kit/safety';

/**
 * Stopping every device, with the outcome actually reaching the user.
 *
 * `stopAllSafetySessions` is best-effort by design: one module throwing must
 * not abort the others, so it returns which sessions failed instead of
 * rejecting. Every call site dropped that return value — the primary stop
 * button in the device bar discarded it outright, and the one place that did
 * look at it only wrote to `console.error`, under a comment saying the user
 * must know to physically disconnect. They were not told.
 *
 * A stop control that reports success it did not achieve is the worst defect
 * this product can have: the button goes back to reading 停止 while current
 * is still flowing. So failures land in a store here, and the shell renders
 * them.
 *
 * The store is module-level rather than component state because two of the
 * four callers are not components with hooks — the module error boundary
 * (which stops because the module's own stop button just went down with the
 * crash) and the safety-notice decline path.
 */

let failedLabels: string[] = [];
const listeners = new Set<() => void>();

function publish(next: string[]): void {
  const same = next.length === failedLabels.length && next.every((v, i) => v === failedLabels[i]);
  if (same) return;
  failedLabels = next;
  for (const l of listeners) l();
}

/** Modules whose devices did not confirm a stop. Empty means the last stop fully succeeded. */
export function stopFailureLabels(): string[] {
  return failedLabels;
}

export function subscribeStopFailure(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Add a failed stop reported by a shell-level lifecycle controller. */
export function reportStopFailure(label: string): void {
  if (!label || failedLabels.includes(label)) return;
  publish([...failedLabels, label]);
}

/** Dismiss the warning. Only the user does this — never clear it on their behalf. */
export function clearStopFailure(): void {
  publish([]);
}

/**
 * Stop every registered device session and record what did not stop.
 *
 * Use this everywhere instead of `stopAllSafetySessions` directly, so no
 * call site can silently drop the outcome again.
 */
export async function stopAllDevices(): Promise<void> {
  // Snapshot labels first: after a successful stop a module may drop its
  // session, and then a failed id would have nothing to resolve against.
  const labelById = new Map<string, string>();
  for (const s of activeSafetySessions()) labelById.set(s.id, s.label);
  for (const g of allConnectedDevices()) labelById.set(g.sessionId, g.label);

  try {
    const result = await stopAllSafetySessions();
    publish(result.failed.map((f) => labelById.get(f.id) ?? f.id));
  } catch {
    // It is written not to reject. If it ever does, the honest reading is
    // "nothing is confirmed stopped", not "everything is fine".
    publish([...new Set(labelById.values())]);
  }
}
