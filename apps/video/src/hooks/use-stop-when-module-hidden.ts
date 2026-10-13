import { useEffect, useRef } from 'react';
import { useModuleActive } from '@0xnullai/ui';

/**
 * Run `stop` as soon as the shell hides this module (the user switched to another page,
 * opened settings, or went back to the inbox). Video must not keep the camera, its frame
 * capture loop or a vision run going behind a page the person has left.
 *
 * Reads the shell's own visibility contract (`useModuleActive`) rather than watching the
 * slot's DOM attributes: that observer depended on the exact markup between this root
 * and the shell slot, and any change to it would have silently left the camera on.
 * Standalone (no shell) the module is always active and this never fires.
 */
export function useStopWhenModuleHidden(stop: () => void): void {
  const active = useModuleActive();
  const stopRef = useRef(stop);
  useEffect(() => {
    stopRef.current = stop;
  });
  useEffect(() => {
    if (!active) stopRef.current();
  }, [active]);
}
