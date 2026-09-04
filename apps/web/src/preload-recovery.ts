const KEY = '0xnuller.module-preload-refresh';
export function recoverPreloadFailure(
  event: Event,
  environment: {
    storage: () => Pick<Storage, 'getItem' | 'setItem'>;
    reload: () => void;
    now: () => number;
  },
): boolean {
  try {
    const storage = environment.storage();
    const now = environment.now();
    const last = Number(storage.getItem(KEY) ?? 0);
    if (Number.isFinite(last) && now - last < 60_000) return false;
    storage.setItem(KEY, String(now));
  } catch {
    return false;
  }
  event.preventDefault();
  environment.reload();
  return true;
}
