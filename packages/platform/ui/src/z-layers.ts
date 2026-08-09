/**
 * Stacking classes for overlay surfaces.
 *
 * A backdrop and the panel it dims are `position:fixed` siblings inside the
 * same portal container, so their order is decided purely by z-index. That
 * makes "backdrop below, panel above" a two-place invariant, and it broke
 * exactly that way once: the backdrop was moved onto the z token (100)
 * while the panel kept a hand-written `z-50`, so every Dialog and Sheet in
 * the product rendered *behind* its own scrim. The page dimmed and blurred
 * with no dialog visible, and Radix then closed it on the next click.
 *
 * Nothing about that is visible in a class string read on its own — you
 * have to hold both files side by side to see it. So the pair lives here,
 * and consumers import rather than retype.
 */

/** Backdrop / scrim. */
export const Z_OVERLAY = 'z-[var(--z-module-overlay)]';

/** The panel that sits on the backdrop. Must always outrank Z_OVERLAY. */
export const Z_OVERLAY_PANEL = 'z-[calc(var(--z-module-overlay)+1)]';
