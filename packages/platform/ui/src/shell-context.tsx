import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

/**
 * What the shell provides to modules.
 *
 * Each module is an independently deployable app, so it ships a complete
 * chrome: app switcher, theme button, title, its own settings panel. Inside
 * the shell those duplicate one-for-one — two app switchers, two theme
 * buttons, the same setting editable in two places.
 *
 * Modules use `useInShell()` to hide controls the shell already provides;
 * standalone (no Provider) it defaults to false and behavior matches
 * pre-merge exactly. Use it ONLY to hide duplicated shell-level chrome —
 * not to branch module logic, which would quietly fork the two runtime
 * forms.
 */

export type ShellSettingsTab = 'account' | 'appearance' | 'ai' | 'scenes' | 'safety';

interface ShellChrome {
  inShell: boolean;
  /** Whether the unified shell currently has an authenticated account. */
  signedIn: boolean;
  /**
   * Open the shell's one settings panel, optionally on a specific tab.
   *
   * This grants an entry point, not a second settings UI: places in module
   * UIs that deserve a settings entry (e.g. Chat's host-configures-AI
   * button) keep their button — it just opens the same panel.
   */
  openSettings: (tab?: ShellSettingsTab) => void;
}

const ShellChromeContext = createContext<ShellChrome>({
  inShell: false,
  signedIn: false,
  openSettings: () => undefined,
});

export function ShellChromeProvider({
  children,
  openSettings,
  signedIn,
}: {
  children: ReactNode;
  openSettings: (tab?: ShellSettingsTab) => void;
  signedIn: boolean;
}) {
  // Deliberately not memoized: the Shell rebuilds this object every
  // render, but the consumers are a handful of buttons — and memoization
  // introduces a "did openSettings change" dependency where a mistake
  // means a button that does nothing.
  return (
    <ShellChromeContext.Provider value={{ inShell: true, signedIn, openSettings }}>
      {children}
    </ShellChromeContext.Provider>
  );
}

export function useInShell(): boolean {
  return useContext(ShellChromeContext).inShell;
}

/** Current unified-shell account state. Standalone modules keep their existing flow. */
export function useShellSignedIn(): boolean {
  return useContext(ShellChromeContext).signedIn;
}

/** Open the shell settings panel. A no-op outside the shell — the module's own panel still works there. */
export function useOpenShellSettings(): (tab?: ShellSettingsTab) => void {
  return useContext(ShellChromeContext).openSettings;
}
