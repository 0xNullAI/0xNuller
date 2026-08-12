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

/** Popovers which stay inside normal module content. */
export const Z_LOCAL_POPOVER = 'z-[var(--z-local-popover)]';

/** Non-modal voice/update status surface inside module content. */
export const Z_FLOATING_STATUS = 'z-[var(--z-floating-status)]';

/** Narrow-screen shell scrim. */
export const Z_SHELL = 'z-[var(--z-shell)]';

/** Narrow-screen shell drawer, above its scrim. */
export const Z_SHELL_PANEL = 'z-[var(--z-shell-panel)]';

/** Menus owned by shell chrome. */
export const Z_SHELL_POPOVER = 'z-[var(--z-shell-popover)]';

/** Backdrop / scrim. Dialogs intentionally outrank all shell chrome. */
export const Z_OVERLAY = 'z-[var(--z-module-overlay)]';

/** The panel that sits on the backdrop. Must always outrank Z_OVERLAY. */
export const Z_OVERLAY_PANEL = 'z-[var(--z-overlay-panel)]';

/** Secondary overlay opened while another overlay is still present. */
export const Z_OVERLAY_STACKED = 'z-[var(--z-overlay-stacked)]';

/**
 * A popover opened from inside an overlay (Select, combobox menus, etc.).
 *
 * These portal beside the overlay surface rather than inside its stacking
 * context. A plain `z-50` therefore renders behind the surface at 100: the
 * options exist in the DOM, but the dialog body wins hit testing and every
 * click appears to do nothing. Keep enough room above the stacked-overlay
 * level (+10) so selects also work inside secondary dialogs.
 */
export const Z_OVERLAY_POPOVER = 'z-[var(--z-overlay-popover)]';

/** Transient application notifications. */
export const Z_TOAST = 'z-[var(--z-toast)]';
