import { createContext, useContext, useEffect } from 'react';
import type { ReactNode } from 'react';

/**
 * One header for nested settings pages. A page inside a settings tab registers its title
 * and back action; the settings panel shows them in its own header, so the screen keeps a
 * single back arrow instead of a tab header stacked over a page header.
 *
 * Without a provider (the page rendered outside the settings panel) the hook returns false
 * and the page keeps its own back row.
 */
export interface SettingsSubpage {
  title: string;
  onBack: () => void;
}

type Register = (page: SettingsSubpage | null) => void;

const SettingsSubpageContext = createContext<Register | null>(null);

export function SettingsSubpageProvider({
  onChange,
  children,
}: {
  onChange: Register;
  children: ReactNode;
}) {
  return (
    <SettingsSubpageContext.Provider value={onChange}>{children}</SettingsSubpageContext.Provider>
  );
}

/** Registers the open sub-page while mounted. Returns whether a shared header shows it. */
export function useSettingsSubpage(page: SettingsSubpage | null): boolean {
  const register = useContext(SettingsSubpageContext);
  const title = page?.title;
  const onBack = page?.onBack;
  useEffect(() => {
    if (!register) return;
    register(title && onBack ? { title, onBack } : null);
    return () => register(null);
  }, [register, title, onBack]);
  return register !== null;
}
