import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * Overlay mount point.
 *
 * Module dialogs must portal here — not `position:fixed` inside the module
 * subtree, and not defaulting to `document.body`.
 *
 * Why not the module subtree: those overlays sit in an unstable middle
 * state. With no transformed ancestor, their containing block is the
 * viewport → they cover the whole screen including the shell chrome; the
 * moment the shell puts transform / filter / contain:paint on the module
 * slot (the natural way to animate switching), the containing block flips
 * to the module box → the modal can't trap clicks and the user can reach
 * behind it. Both failures are unacceptable.
 *
 * Why the container is a *sibling* of the shell root, not a descendant:
 * same reason — as long as it is not a descendant of the slot, no
 * transform on the slot can affect it.
 *
 * Standalone (no shell), useOverlayContainer returns undefined and Radix
 * falls back to document.body — same behavior as before the merge.
 */

const OverlayContext = createContext<HTMLElement | undefined>(undefined);

/** Provided by the shell. Pass the container the shell created as a sibling of its root. */
export function OverlayProvider({
  container,
  children,
}: {
  container: HTMLElement | undefined;
  children: ReactNode;
}) {
  return <OverlayContext.Provider value={container}>{children}</OverlayContext.Provider>;
}

/**
 * Get the overlay container. Pass it to Radix's `container` prop:
 * `<DialogPrimitive.Portal container={useOverlayContainer()}>`
 *
 * When it returns undefined Radix uses document.body — the desired standalone behavior.
 */
export function useOverlayContainer(): HTMLElement | undefined {
  return useContext(OverlayContext);
}

/**
 * Create an overlay container as a sibling of the shell root. The shell
 * calls this once on mount.
 *
 * The container itself is `pointer-events:none`; individual overlays opt
 * back in with `pointer-events:auto` — so with no dialog open it does not
 * swallow clicks on the whole page.
 */
export function useOverlayRoot(id = 'shl-overlay-root'): HTMLElement | undefined {
  const [el, setEl] = useState<HTMLElement>();

  useEffect(() => {
    let node = document.getElementById(id);
    let created = false;
    if (!node) {
      node = document.createElement('div');
      node.id = id;
      node.style.cssText = 'position:fixed;inset:0;pointer-events:none;';
      document.body.appendChild(node);
      created = true;
    }
    setEl(node);
    return () => {
      if (created && node?.parentNode) node.parentNode.removeChild(node);
    };
  }, [id]);

  return el;
}

/**
 * One overlay sublayer per module, shown/hidden by the shell with the
 * active module.
 *
 * Why: once a dialog portals out of the module subtree, `hidden` on the
 * module container no longer reaches it. Observed symptom — open the
 * safety notice in Chat, switch to Market, and Chat's dialog still floats
 * over Market, squeezed into a narrow column. A per-module sublayer that
 * hides with its module lets "switched-away modules stay mounted" and
 * "switched-away modules must not surface dialogs" both hold.
 */
export function useModuleOverlayLayer(
  root: HTMLElement | undefined,
  moduleId: string,
  active: boolean,
): HTMLElement | undefined {
  const [el, setEl] = useState<HTMLElement>();

  useEffect(() => {
    if (!root) return;
    const node = document.createElement('div');
    node.dataset.overlayLayer = moduleId;
    node.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    root.appendChild(node);
    setEl(node);
    return () => {
      node.remove();
      setEl(undefined);
    };
  }, [root, moduleId]);

  useEffect(() => {
    if (!el) return;
    // display, not visibility: elements in a hidden layer must not take
    // part in hit testing, nor be read by screen readers.
    el.style.display = active ? '' : 'none';
  }, [el, active]);

  return el;
}
