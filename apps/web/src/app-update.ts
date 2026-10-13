import { useSyncExternalStore } from 'react';
import { stopAllDevices } from '@0xnullai/ui';

/**
 * A new deployment replaced the chunks this tab was built against.
 *
 * Vite reports it as `vite:preloadError` when a lazily loaded page still points at an
 * old hash. The shell used to answer with an immediate `location.reload()`: no stop
 * first, and an active call, room or device session simply vanished mid-use. Now the
 * failure is recorded here, the shell shows a reload banner, and reloading always goes
 * through `stopThenReload` — the same path the module error boundary uses — so devices
 * are confirmed stopped before the page goes away.
 *
 * The failed import itself still rejects (the event is not prevented), so the page that
 * could not load lands in its ModuleErrorBoundary, which stops devices on catch.
 */

export interface AppUpdateState {
  status: 'current' | 'available' | 'stopping' | 'stop-failed';
}

let state: AppUpdateState = { status: 'current' };
const listeners = new Set<() => void>();

function publish(next: AppUpdateState): void {
  state = next;
  for (const listener of listeners) listener();
}

/** Record that this tab runs an outdated build. */
export function markAppUpdated(): void {
  if (state.status === 'current') publish({ status: 'available' });
}

export function appUpdateState(): AppUpdateState {
  return state;
}

export function subscribeAppUpdate(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAppUpdate(): AppUpdateState {
  return useSyncExternalStore(subscribeAppUpdate, appUpdateState, appUpdateState);
}

/**
 * Stop every device, and reload only once that is confirmed. A stop that did not take
 * leaves the page in place (StopFailureBanner tells the user to disconnect by hand)
 * rather than reloading over a device that may still be running.
 */
export async function stopThenReload(reload: () => void = () => window.location.reload()) {
  const wasUpdate = state.status !== 'current';
  if (wasUpdate) publish({ status: 'stopping' });
  // stopAllDevices does not reject by contract; if it ever does, nothing is confirmed.
  const stopped = await Promise.resolve()
    .then(() => stopAllDevices())
    .catch(() => false);
  if (stopped) reload();
  else if (wasUpdate) publish({ status: 'stop-failed' });
  return stopped;
}

/** Test seam. */
export function resetAppUpdateForTests(): void {
  state = { status: 'current' };
}
