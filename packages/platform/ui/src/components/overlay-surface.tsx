import { useEffect, useRef, type ReactNode, type MouseEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useOverlayContainer } from '../overlay';
import { cn } from '../utils';

/**
 * Overlay surface: backdrop + centering + portal.
 *
 * Pre-merge all four modules hand-wrote `<div className="fixed inset-0
 * z-50 flex items-center justify-center bg-black/40 p-4">` with five
 * backdrop opacities (/30 /38 /40 /50 /80), two z values (50 and 60), and
 * no portal — left in the module subtree, where a transformed ancestor
 * decided between "covers the shell" and "modal can't trap clicks".
 *
 * This component replaces that line; backdrop strength and stacking go
 * through tokens, the portal goes to the shell container. Standalone the
 * container is undefined and falls back to document.body — behavior
 * unchanged.
 *
 * It also owns dialog keyboard behavior for the whole product, because
 * none of the four modules had any: Escape closed nothing, Tab walked out
 * of the dialog into the page behind it, and closing a dialog dropped
 * focus to the document. Putting it here means every consumer gets it
 * without opting in.
 *
 * Escape is tied to `onDismiss`, so an overlay that deliberately demands
 * an explicit answer — the safety notice, the permission modal — stays
 * un-escapable for the same reason its backdrop is inert. That coupling is
 * the point: those two must not gain a keyboard escape hatch by accident.
 */

/**
 * Innermost dismissible overlay wins Escape.
 *
 * Overlays stack (a scene picker opened from the settings dialog), and
 * Escape must close only the top one. A module-level stack is the simplest
 * thing that gets nesting right; a per-overlay listener would close all of
 * them at once.
 */
const dismissStack: { dismiss: () => void }[] = [];

function handleEscapeKey(event: globalThis.KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  const top = dismissStack[dismissStack.length - 1];
  if (!top) return;
  event.stopPropagation();
  top.dismiss();
}

function pushDismissible(entry: { dismiss: () => void }): void {
  if (dismissStack.length === 0) document.addEventListener('keydown', handleEscapeKey);
  dismissStack.push(entry);
}

function popDismissible(entry: { dismiss: () => void }): void {
  const i = dismissStack.indexOf(entry);
  if (i !== -1) dismissStack.splice(i, 1);
  if (dismissStack.length === 0) document.removeEventListener('keydown', handleEscapeKey);
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Skips hidden controls by hidden-ness, not by measured size. Size-based
 * visibility checks (offsetWidth/offsetParent) report 0 for everything
 * before layout runs, which would silently collapse the trap to a single
 * element.
 */
function focusableWithin(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.closest('[hidden],[aria-hidden="true"]'),
  );
}

export interface OverlayProps {
  children: ReactNode;
  /** Close on backdrop click. Omit to make the backdrop inert (for flows that demand explicit confirmation, e.g. the safety notice). */
  onDismiss?: () => void;
  /** Backdrop strength. `strong` for flows that must obscure what's below (e.g. an image viewer). */
  scrim?: 'default' | 'strong';
  /** Stacking. Default is the module overlay layer; `stacked` for a secondary dialog above another overlay. */
  level?: 'module' | 'stacked';
  className?: string;
}

export function Overlay({
  children,
  onDismiss,
  scrim = 'default',
  level = 'module',
  className,
}: OverlayProps) {
  const container = useOverlayContainer();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dismissRef = useRef(onDismiss);
  const dismissible = Boolean(onDismiss);

  // No dep array: Escape can only arrive after a render has painted, so the
  // stack entry always calls through to the current handler without having
  // to re-register (and re-order) itself whenever the caller passes a fresh
  // inline arrow.
  useEffect(() => {
    dismissRef.current = onDismiss;
  });

  useEffect(() => {
    if (!dismissible) return;
    const entry = { dismiss: () => dismissRef.current?.() };
    pushDismissible(entry);
    return () => popDismissible(entry);
  }, [dismissible]);

  // Move focus in on open and put it back on close. Focus lands on the
  // surface itself rather than the first control: focusing a control would
  // pop the on-screen keyboard on Android when a dialog happens to open
  // with a text field first.
  useEffect(() => {
    const restoreTo = document.activeElement as HTMLElement | null;
    const surface = surfaceRef.current;
    if (surface && !surface.contains(document.activeElement)) surface.focus();
    return () => restoreTo?.focus?.();
  }, []);

  function handleMouseDown(e: MouseEvent<HTMLDivElement>) {
    // Close only when the backdrop itself is clicked, not the content.
    if (onDismiss && e.target === e.currentTarget) onDismiss();
  }

  // Keep Tab inside the dialog. Without this it walks into the page behind
  // the backdrop, where clicks are blocked but keyboard focus is not — the
  // user ends up typing into something they cannot see.
  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Tab') return;
    const surface = surfaceRef.current;
    if (!surface) return;
    const items = focusableWithin(surface);
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === surface)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  const node = (
    <div
      ref={surfaceRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className={cn(
        'fixed inset-0 flex items-center justify-center p-4 focus:outline-none',
        className,
      )}
      style={{
        background: scrim === 'strong' ? 'var(--overlay-scrim-strong)' : 'var(--overlay-scrim)',
        zIndex:
          level === 'stacked' ? 'calc(var(--z-module-overlay) + 10)' : 'var(--z-module-overlay)',
        pointerEvents: 'auto',
      }}
      onMouseDown={handleMouseDown}
      role={onDismiss ? 'presentation' : undefined}
    >
      {children}
    </div>
  );

  return container ? createPortal(node, container) : node;
}
