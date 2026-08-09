import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ComponentType, ReactNode } from 'react';

/**
 * Module-owned pages inside the one settings panel.
 *
 * The rule is that every setting lives in the shell's panel. Most of them
 * could simply move, because they were already backed by a shared store. A
 * few could not: Agent's sensor thresholds, waveform library and data export
 * read that module's *live* state — its settings draft, its session list —
 * and the shell neither has that state nor should grow a dependency on it.
 *
 * So the page is declared where the state is and rendered where the panel is.
 * The shell owns the navigation, the ordering and the chrome; the module owns
 * only the contents of its own page.
 *
 * Portal rather than "the module registers a render function", for the reason
 * the sidebar seam records: a render function makes the shell re-render
 * whenever module state changes, and the shell knows nothing about module
 * state. Written that way, the sections never appeared at all. A portal ties
 * the content to the module's own render cycle instead.
 */

export interface ModuleSettingsClaim {
  id: string;
  label: string;
  icon?: ComponentType<{ className?: string }>;
  /** Lower sorts first. Shell-owned pages occupy 0-99; module pages default to 100. */
  order: number;
}

interface Registry {
  claims: ModuleSettingsClaim[];
  claim: (claim: ModuleSettingsClaim) => void;
  release: (id: string) => void;
  containers: Record<string, HTMLElement>;
  setContainer: (id: string, el: HTMLElement | null) => void;
}

const Ctx = createContext<Registry | null>(null);

export function ModuleSettingsProvider({ children }: { children: ReactNode }) {
  const [claims, setClaims] = useState<ModuleSettingsClaim[]>([]);
  const [containers, setContainers] = useState<Record<string, HTMLElement>>({});

  const claim = useCallback((next: ModuleSettingsClaim) => {
    setClaims((prev) => {
      const existing = prev.find((c) => c.id === next.id);
      if (existing && existing.label === next.label && existing.order === next.order) return prev;
      return [...prev.filter((c) => c.id !== next.id), next].sort((a, b) => a.order - b.order);
    });
  }, []);

  const release = useCallback((id: string) => {
    setClaims((prev) => (prev.some((c) => c.id === id) ? prev.filter((c) => c.id !== id) : prev));
  }, []);

  const setContainer = useCallback((id: string, el: HTMLElement | null) => {
    setContainers((prev) => {
      if (prev[id] === (el ?? undefined)) return prev;
      const next = { ...prev };
      if (el) next[id] = el;
      else delete next[id];
      return next;
    });
  }, []);

  const value = useMemo<Registry>(
    () => ({ claims, claim, release, containers, setContainer }),
    [claims, claim, release, containers, setContainer],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Declared by a module, rendered in the shell's settings panel.
 *
 * Standalone (no Provider) it renders nothing rather than in place: unlike a
 * toolbar button, a settings page has nowhere sensible to fall back to.
 */
export function ModuleSettingsSection({
  id,
  label,
  icon,
  order = 100,
  children,
}: {
  id: string;
  label: string;
  icon?: ComponentType<{ className?: string }>;
  order?: number;
  children: ReactNode;
}) {
  const ctx = useContext(Ctx);
  const { claim, release } = ctx ?? {};

  useEffect(() => {
    if (!claim || !release) return;
    claim({ id, label, icon, order });
    return () => release(id);
  }, [claim, release, id, label, icon, order]);

  const container = ctx?.containers[id];
  if (!container) return null;
  return createPortal(children, container);
}

/** Shell side: the pages modules have declared, in display order. */
export function useModuleSettingsClaims(): ModuleSettingsClaim[] {
  return useContext(Ctx)?.claims ?? [];
}

/** Shell side: where a module page's content lands. Rendered only for the active page. */
export function ModuleSettingsSlot({ id }: { id: string }) {
  const ctx = useContext(Ctx);
  const setContainer = ctx?.setContainer;

  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      setContainer?.(id, el);
    },
    [setContainer, id],
  );

  useEffect(() => () => setContainer?.(id, null), [setContainer, id]);

  return <div ref={ref} className="flex flex-col gap-4" />;
}
