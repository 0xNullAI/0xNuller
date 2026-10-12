import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

/**
 * Shell navigation. Modules use it to know "where am I" and "how to get
 * elsewhere".
 *
 * Standalone (no Provider), `useShellNav()` returns null and switchers fall
 * back to real navigation (each app on its own domain). Inside the shell it
 * is same-document routing — no reload, BLE connections and module state
 * survive.
 */

export interface ShellModule {
  id: string;
  /** Name shown at the top of the sidebar. No DG- prefix. */
  label: string;
  /** One-line description. */
  blurb: string;
}

export interface ShellNav {
  activeId: string | null;
  modules: readonly ShellModule[];
  navigate: (moduleId: string | null) => void;
  /**
   * Present on a phone-width screen while one conversation fills the screen. The module
   * shows it as the back arrow in its own conversation header, so the screen keeps a
   * single top bar instead of a shell bar stacked over the conversation header.
   */
  conversationBack?: () => void;
}

const ShellNavContext = createContext<ShellNav | null>(null);

export function ShellNavProvider({ value, children }: { value: ShellNav; children: ReactNode }) {
  return <ShellNavContext.Provider value={value}>{children}</ShellNavContext.Provider>;
}

export function useShellNav(): ShellNav | null {
  return useContext(ShellNavContext);
}
