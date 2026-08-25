/**
 * Serialize a Video target switch behind the old grant's confirmed stop.
 * Callers own the concrete runtimes; this small boundary makes it impossible
 * to publish the new identity when stopping the old target rejects.
 */
export async function switchVideoOutputTarget(
  currentId: string | null,
  nextId: string,
  stopCurrent: () => Promise<void>,
  invalidateCurrentGrant: () => void,
  commit: (targetId: string) => void,
): Promise<boolean> {
  if (currentId === nextId) return false;
  try {
    await stopCurrent();
  } finally {
    // A failed stop is latched by the owning runtime, but the UI must also
    // discard its resumable grant snapshot before surfacing that failure.
    invalidateCurrentGrant();
  }
  commit(nextId);
  return true;
}
