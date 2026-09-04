/** Subscribe without assuming MediaQueryList inherits EventTarget (older WebViews). */
export function subscribeMediaQuery(media: MediaQueryList, listener: () => void): () => void {
  if (typeof media.addEventListener === 'function') {
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }
  media.addListener(listener);
  return () => media.removeListener(listener);
}
