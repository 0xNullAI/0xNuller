/**
 * Page-memory sharing for public Market portraits. Every assistant message row mounts its own
 * avatar; without this each one downloaded the same portrait. One read per portrait is shared
 * by everyone asking while it is in flight, and a successful image is kept for the session.
 */

// Portraits are capped at 4 MB each; keep only the most recently used few.
const MAX_CACHED_PORTRAITS = 24;

const portraits = new Map<string, Promise<Blob | null>>();

export function sharedPortraitRead(
  url: string,
  signal: AbortSignal | undefined,
  read: () => Promise<Blob | null>,
): Promise<Blob | null> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  let shared = portraits.get(url);
  if (shared) {
    // Most recently used goes last, so eviction drops the oldest.
    portraits.delete(url);
    portraits.set(url, shared);
  } else {
    const created = read().then(
      (blob) => {
        // A missing or failed image is not remembered: the next caller tries again.
        if (!blob && portraits.get(url) === created) portraits.delete(url);
        return blob;
      },
      (error: unknown) => {
        if (portraits.get(url) === created) portraits.delete(url);
        throw error;
      },
    );
    portraits.set(url, created);
    while (portraits.size > MAX_CACHED_PORTRAITS) {
      const oldest = portraits.keys().next().value;
      if (oldest === undefined) break;
      portraits.delete(oldest);
    }
    shared = created;
  }
  if (!signal) return shared;
  // One caller cancelling must not cancel the read the others share; it only stops waiting.
  return new Promise<Blob | null>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    shared.then(
      (blob) => {
        signal.removeEventListener('abort', onAbort);
        resolve(blob);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}
