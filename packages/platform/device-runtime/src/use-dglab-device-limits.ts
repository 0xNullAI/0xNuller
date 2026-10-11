import { useEffect, useState } from 'react';
import type {
  DgLabConnectionRegistry,
  DgLabDeviceLimitEntry,
} from './dglab/dglab-connection-registry.js';

/**
 * Live per-device limit rows for the settings page: connected Coyotes and Opossums first, then
 * remembered ones that are not attached. Edit through `registry.setOwnLimits` and
 * `registry.forgetDeviceLimits`; neither needs the module lease.
 *
 * The registry emits on every protocol tick while a device is attached, so an unchanged list
 * keeps its previous reference instead of re-rendering the page ten times a second.
 */
export function useDgLabDeviceLimits(registry: DgLabConnectionRegistry): DgLabDeviceLimitEntry[] {
  const [entries, setEntries] = useState(() => registry.listDeviceLimits());

  useEffect(() => {
    const refresh = () => {
      const next = registry.listDeviceLimits();
      setEntries((previous) => (sameEntries(previous, next) ? previous : next));
    };
    refresh();
    return registry.subscribeDeviceLimits(refresh);
  }, [registry]);

  return entries;
}

function sameEntries(a: DgLabDeviceLimitEntry[], b: DgLabDeviceLimitEntry[]): boolean {
  return a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
}
