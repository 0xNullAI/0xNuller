import type { ReactNode, MouseEvent } from 'react';
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
 */

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

  function handleMouseDown(e: MouseEvent<HTMLDivElement>) {
    // Close only when the backdrop itself is clicked, not the content.
    if (onDismiss && e.target === e.currentTarget) onDismiss();
  }

  const node = (
    <div
      className={cn('fixed inset-0 flex items-center justify-center p-4', className)}
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
