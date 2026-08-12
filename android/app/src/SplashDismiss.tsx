import { useLayoutEffect } from 'react';

/** Remove the static splash only after React has committed a real frame. */
export function SplashDismiss(): null {
  useLayoutEffect(() => {
    const splash = document.getElementById('nx-splash');
    if (!splash) return;
    const frame = requestAnimationFrame(() => {
      splash.classList.add('nx-splash-loaded');
      window.setTimeout(() => splash.remove(), 250);
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return null;
}
