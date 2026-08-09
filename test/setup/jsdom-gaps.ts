/**
 * As of Node 26, `localStorage` is a built-in global: without `--localstorage-file`
 * it is `undefined`, and it **shadows jsdom's own implementation**. The result is
 * that under jsdom neither `localStorage` nor `window.localStorage` resolves, and
 * any test that touches it dies right there with
 * `TypeError: Cannot read properties of undefined`.
 *
 * This is not a problem this repo introduced — the separate repos failed the same
 * way on Node 26 before the merge; CI runs Node 20 and is unaffected. So the fix
 * cannot depend on a node flag (`--localstorage-file` is experimental, and it
 * persists to a file, which would leak state between tests).
 *
 * When localStorage is detected as unusable, this installs a pure in-memory
 * implementation: on Node 20 jsdom's real existing implementation is left in place,
 * on Node 26 you get a per-test-process, semantically equivalent stand-in.
 */

class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(String(key)) ?? null;
  }

  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(String(key));
  }

  setItem(key: string, value: string): void {
    this.store.set(String(key), String(value));
  }
}

function install(name: 'localStorage' | 'sessionStorage'): void {
  const existing = (globalThis as Record<string, unknown>)[name];
  // If a usable implementation is already there (Node 20 + jsdom), leave it alone.
  if (existing && typeof (existing as Storage).getItem === 'function') return;

  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, name, {
    value: storage,
    writable: true,
    configurable: true,
  });
  // Under jsdom window is globalThis, but set it explicitly in case an environment
  // implementation differs.
  if (typeof window !== 'undefined' && window !== (globalThis as unknown)) {
    Object.defineProperty(window, name, { value: storage, writable: true, configurable: true });
  }
}

install('localStorage');
install('sessionStorage');

/**
 * jsdom does not implement `window.matchMedia`. Any code that takes the branch for
 * following the system color scheme throws a TypeError outright in tests — the same
 * class of environment gap as the localStorage case above, so it is handled here too.
 *
 * The default answer is "no match", i.e. light. Cases that need to test dark can
 * mock over it themselves.
 */
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  });
}


/**
 * jsdom ships no IndexedDB, and the shared waveform library is backed by it.
 * Installed only when missing, so a real implementation is left alone.
 */
if (typeof globalThis.indexedDB === 'undefined') {
  const { indexedDB, IDBKeyRange } = await import('fake-indexeddb');
  Object.defineProperty(globalThis, 'indexedDB', { value: indexedDB, configurable: true });
  Object.defineProperty(globalThis, 'IDBKeyRange', { value: IDBKeyRange, configurable: true });
}
