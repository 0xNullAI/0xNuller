/** Keep the filter menu within the visible viewport when Market is scrolled. */
export function filterPlacement(
  trigger: Pick<DOMRect, 'top' | 'bottom'>,
  viewportHeight: number,
  preferredHeight = 320,
  pane?: Pick<DOMRect, 'top' | 'bottom'>,
): { side: 'top' | 'bottom'; maxHeight: number } {
  const margin = 16;
  const gap = 8;
  const visibleTop = Math.max(0, pane?.top ?? 0);
  const visibleBottom = Math.min(viewportHeight, pane?.bottom ?? viewportHeight);
  const below = Math.max(0, visibleBottom - trigger.bottom - margin - gap);
  const above = Math.max(0, trigger.top - visibleTop - margin - gap);
  const side = below >= preferredHeight || below >= above ? 'bottom' : 'top';
  return { side, maxHeight: side === 'bottom' ? below : above };
}
