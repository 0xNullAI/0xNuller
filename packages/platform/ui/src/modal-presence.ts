import { useEffect } from 'react';

/**
 * How many blocking surfaces (Dialog, Sheet, Overlay) are open right now.
 *
 * A modal makes the page behind it unreachable on purpose: Radix locks
 * pointer events on <body> and hides the rest from assistive tech, and the
 * shared Overlay covers the page with a scrim. The shell device bar — and
 * its stop button — is part of "the page behind it". The shell reads this
 * count to raise a stop control above every modal while one is open, so stop
 * stays one action away instead of "close the dialog, then stop".
 *
 * A count rather than a flag because surfaces stack: a picker opened from a
 * settings dialog must not clear the state when only the picker closes.
 */

let openCount = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function openModalCount(): number {
  return openCount;
}

export function subscribeModalPresence(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Mark one blocking surface open. Returns the matching close; calling it twice is harmless. */
export function registerOpenModal(): () => void {
  openCount++;
  notify();
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    openCount--;
    notify();
  };
}

/**
 * Count the calling component as an open modal for as long as it is mounted.
 * The shared Dialog, Sheet and Overlay call it; a module that builds its own
 * modal surface straight on a primitive must call it too, or the stop
 * control will not rise above that surface.
 */
export function useBlockingOverlay(open = true): void {
  useEffect(() => (open ? registerOpenModal() : undefined), [open]);
}

/**
 * Marks the elements that belong to the shell's stop control. Modal surfaces
 * treat a press there as "not outside the dialog": stopping a device must
 * not also throw away whatever the user was doing in the dialog.
 */
export const STOP_ANCHOR_ATTRIBUTE = 'data-stop-anchor';

export function isStopAnchorTarget(target: EventTarget | null): boolean {
  return (
    typeof Element !== 'undefined' &&
    target instanceof Element &&
    target.closest(`[${STOP_ANCHOR_ATTRIBUTE}]`) !== null
  );
}
