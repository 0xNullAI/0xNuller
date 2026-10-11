import { useEffect, useSyncExternalStore } from 'react';

/**
 * One header for nested settings pages. A page inside a settings tab registers its title
 * and back action; the settings panel shows them in its own header, so the screen keeps a
 * single back arrow instead of a tab header stacked over a page header.
 *
 * This is a module store, not React context: module settings pages render through a
 * portal from the module's own tree, so a provider in the settings panel never reaches
 * them. While no settings panel is mounted, the hook returns false and the page keeps its
 * own back row.
 */
export interface SettingsSubpage {
  title: string;
  onBack: () => void;
}

let current: SettingsSubpage | null = null;
let panels = 0;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The settings panel calls this while mounted and shows the returned sub-page, if any. */
export function useSettingsSubpageHeader(): SettingsSubpage | null {
  useEffect(() => {
    panels += 1;
    notify();
    return () => {
      panels -= 1;
      if (panels === 0) current = null;
      notify();
    };
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}

/** Registers the open sub-page while mounted. Returns whether a shared header shows it. */
export function useSettingsSubpage(page: SettingsSubpage | null): boolean {
  const shared = useSyncExternalStore(
    subscribe,
    () => panels > 0,
    () => false,
  );
  const title = page?.title;
  const onBack = page?.onBack;
  useEffect(() => {
    if (!shared || !title || !onBack) return;
    const registered = { title, onBack };
    current = registered;
    notify();
    return () => {
      if (current === registered) {
        current = null;
        notify();
      }
    };
  }, [shared, title, onBack]);
  return shared;
}
