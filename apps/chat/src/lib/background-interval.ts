/**
 * An interval that keeps its pace in a background tab.
 *
 * Browsers throttle a hidden page's timers (to once a minute after a while, or not at all in an
 * Android WebView), but not a dedicated worker's. Safety backstops that must run on time, such
 * as ending a fire boost whose release was lost, use this. Falls back to setInterval where
 * workers are unavailable. Returns the function that stops it.
 */
export function backgroundInterval(callback: () => void, ms: number): () => void {
  try {
    const code = `const t=setInterval(()=>postMessage(1),${Math.max(16, Math.round(ms))});`;
    const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = () => callback();
    return () => worker.terminate();
  } catch {
    const timer = setInterval(callback, ms);
    return () => clearInterval(timer);
  }
}
