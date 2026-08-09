import { createContext, useContext, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

/**
 * Modules project their toolbar buttons onto the shell's bar.
 *
 * Pre-merge every module drew its own header: module name + connect +
 * settings. Inside the shell that meant two stacked bars, with the module
 * name duplicating the highlighted nav item.
 *
 * Now there is one bar: module switcher top-left; the module's own buttons,
 * emergency stop, account, and theme on the right. Modules no longer draw a
 * header — they declare "these are my buttons" and the shell decides where
 * they go.
 *
 * Standalone (no Provider), `<ModuleActions>` renders in place and the
 * module keeps its own header — both forms share the same button code, no
 * fork.
 */

const ActionsContainerContext = createContext<HTMLElement | null>(null);

export function ModuleActionsProvider({
  container,
  children,
}: {
  container: HTMLElement | null;
  children: ReactNode;
}) {
  return (
    <ActionsContainerContext.Provider value={container}>
      {children}
    </ActionsContainerContext.Provider>
  );
}

export function ModuleActions({ children }: { children: ReactNode }) {
  const container = useContext(ActionsContainerContext);
  return container ? createPortal(children, container) : <>{children}</>;
}

/**
 * Shell side: obtain the container element.
 *
 * State, not ref — a ref assignment triggers no re-render, so the Provider
 * would keep seeing null and module buttons would never project in (blank
 * on first paint, and nothing would ever cause another render).
 */
export function useModuleActionsContainer(): [
  (el: HTMLDivElement | null) => void,
  HTMLElement | null,
] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  return [setEl, el];
}
