import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

/**
 * Sidebar sections.
 *
 * Section order, heading typography, and collapse behavior belong to the
 * shell; modules provide only the list items. Three modules each drawing
 * their own list is how you get back to "five UIs".
 *
 * Portal, not "module registers a render function": the latter requires the
 * shell to re-render whenever module state changes, and the shell knows
 * nothing about module state. The first version was written that way and
 * the sections *never appeared* — when the Provider setState'd, children
 * was the same element reference so React skipped the whole subtree, and
 * the context value was pinned by useMemo so consumers weren't notified
 * either. A portal ties the content to the *module's own* render cycle;
 * no coordination layer needed.
 *
 * Four sections exist: pinned / conversations / direct / rooms. Scenes are
 * not in the sidebar (they belong to the content area).
 *
 * `direct` is Chat's private-message list and could not share `conversations`
 * with Agent's session list. A section is one container and a module claims
 * it whole; two modules claiming the same id would interleave their lists in
 * one heading — and both would do it at once, because a module keeps its
 * sidebar content registered after you switch away from it (that is the point
 * of the portal). Two different lists under one word is worse than one more
 * word.
 */

export type SidebarSectionId = 'pinned' | 'conversations' | 'direct' | 'rooms';

/** Render order. Pinned on top — what the user starred should be visible at a glance. */
const ORDER: SidebarSectionId[] = ['pinned', 'conversations', 'direct', 'rooms'];

interface SidebarRegistry {
  /** Sections claimed by modules, with titles. Decides whether the shell draws a section heading. */
  claims: Partial<Record<SidebarSectionId, string>>;
  claim: (id: SidebarSectionId, title: string) => void;
  release: (id: SidebarSectionId) => void;
  containers: Partial<Record<SidebarSectionId, HTMLElement>>;
  setContainer: (id: SidebarSectionId, el: HTMLElement | null) => void;
}

const Ctx = createContext<SidebarRegistry | null>(null);

export function SidebarSectionsProvider({ children }: { children: ReactNode }) {
  const [claims, setClaims] = useState<Partial<Record<SidebarSectionId, string>>>({});
  const [containers, setContainers] = useState<Partial<Record<SidebarSectionId, HTMLElement>>>({});

  const claim = useCallback((id: SidebarSectionId, title: string) => {
    setClaims((prev) => (prev[id] === title ? prev : { ...prev, [id]: title }));
  }, []);

  const release = useCallback((id: SidebarSectionId) => {
    setClaims((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const setContainer = useCallback((id: SidebarSectionId, el: HTMLElement | null) => {
    setContainers((prev) => {
      if (prev[id] === (el ?? undefined)) return prev;
      const next = { ...prev };
      if (el) next[id] = el;
      else delete next[id];
      return next;
    });
  }, []);

  const value = useMemo<SidebarRegistry>(
    () => ({ claims, claim, release, containers, setContainer }),
    [claims, claim, release, containers, setContainer],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Shell side: currently claimed sections, in fixed order. */
export function useClaimedSidebarSections(): { id: SidebarSectionId; title: string }[] {
  const ctx = useContext(Ctx);
  return useMemo(() => {
    if (!ctx) return [];
    return ORDER.flatMap((id) => {
      const title = ctx.claims[id];
      return title ? [{ id, title }] : [];
    });
  }, [ctx]);
}

/**
 * Shell side: register a section's container element; module content
 * portals into it.
 *
 * Depend on the *stable* `setContainer` reference, never on ctx itself.
 * ctx's identity changes with containers, and when a ref callback's
 * identity changes React calls the old one with null and the new one with
 * the element — so setContainer(null) → containers change → new ctx → new
 * callback → setContainer(el) → change again: an infinite loop (observed
 * as React #185, blank page).
 */
export function useSidebarContainerRef(id: SidebarSectionId): (el: HTMLElement | null) => void {
  const setContainer = useContext(Ctx)?.setContainer;
  return useCallback((el: HTMLElement | null) => setContainer?.(id, el), [setContainer, id]);
}

/**
 * Module side: claim a section and project content into it.
 *
 * Standalone (no Provider) renders nothing — no inline fallback, because
 * the sidebar is shell structure and the module has nowhere of its own to
 * put it.
 */
export function SidebarSection({
  id,
  title,
  children,
}: {
  id: SidebarSectionId;
  title: string;
  children: ReactNode;
}) {
  const ctx = useContext(Ctx);
  // Depend on these two *stable* references, not ctx itself: ctx's
  // identity changes with claims/containers, and putting it in the deps
  // becomes a claim → new ctx → re-claim loop.
  const claim = ctx?.claim;
  const release = ctx?.release;

  useEffect(() => {
    if (!claim || !release) return;
    claim(id, title);
    return () => release(id);
  }, [claim, release, id, title]);

  const container = ctx?.containers[id];
  return container ? createPortal(children, container) : null;
}
