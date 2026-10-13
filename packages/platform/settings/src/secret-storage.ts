/**
 * The one storage seam for secrets: the account token and remembered API keys.
 *
 * The web keeps them in localStorage, as before (browsers offer nothing better to a page, and
 * the web account itself rides an HttpOnly cookie). The Android shell exposes an encrypted store
 * backed by the Android Keystore through its synchronous `AndroidSystem` bridge, so the plaintext
 * never sits in the WebView's localStorage files there. The first read on Android moves an
 * existing plaintext value into that store and deletes the plaintext.
 *
 * APKs older than the bridge methods (or a Keystore that refuses a write) keep the previous
 * localStorage behaviour, so nobody is signed out by an update.
 */

/** Android stores the account Bearer token under this name; the web relies on cookies. */
export const AUTH_TOKEN_SECRET = '0xnullai.auth-token';

interface SecureStoreBridge {
  secureGet(key: string): string | null | undefined;
  secureSet(key: string, value: string): boolean;
  secureRemove(key: string): boolean | void;
}

type SecureWindow = { AndroidSystem?: Partial<SecureStoreBridge> };

/** Values already read from or written to the secure store this session. */
const secureCache = new Map<string, string | null>();
/** Set after the secure store refused a write; later writes go to localStorage. */
let secureWritesFailed = false;

function secureBridge(): SecureStoreBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as unknown as SecureWindow).AndroidSystem;
  if (
    bridge &&
    typeof bridge.secureGet === 'function' &&
    typeof bridge.secureSet === 'function' &&
    typeof bridge.secureRemove === 'function'
  ) {
    return bridge as SecureStoreBridge;
  }
  return null;
}

/** Whether secrets are held by the device's encrypted store rather than page storage. */
export function secretsUseDeviceStore(): boolean {
  return secureBridge() !== null && !secureWritesFailed;
}

function localRead(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function localRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Unavailable storage holds nothing to remove.
  }
}

function secureSet(bridge: SecureStoreBridge, key: string, value: string): boolean {
  if (secureWritesFailed) return false;
  try {
    if (bridge.secureSet(key, value) === true) {
      secureCache.set(key, value);
      return true;
    }
  } catch {
    // Treated like a refused write below.
  }
  secureWritesFailed = true;
  return false;
}

export function readSecret(key: string): string | null {
  const bridge = secureBridge();
  if (!bridge) return localRead(key);
  if (secureCache.has(key)) return secureCache.get(key) ?? localRead(key);
  let stored: string | null;
  try {
    stored = bridge.secureGet(key) ?? null;
  } catch {
    stored = null;
  }
  if (stored !== null) {
    secureCache.set(key, stored);
    // A plaintext copy can survive when an earlier deletion failed; it must not stay behind.
    localRemove(key);
    return stored;
  }
  const plaintext = localRead(key);
  if (plaintext !== null && secureSet(bridge, key, plaintext)) {
    localRemove(key);
    return plaintext;
  }
  if (plaintext === null) secureCache.set(key, null);
  return plaintext;
}

/** Stores a secret; an empty or null value removes it. Returns whether it was persisted. */
export function writeSecret(key: string, value: string | null): boolean {
  if (!value) {
    removeSecret(key);
    return true;
  }
  const bridge = secureBridge();
  if (bridge && secureSet(bridge, key, value)) {
    localRemove(key);
    return true;
  }
  if (bridge) secureCache.delete(key);
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeSecret(key: string): void {
  const bridge = secureBridge();
  if (bridge) {
    try {
      bridge.secureRemove(key);
    } catch {
      // The plaintext removal below still runs; a stale secure entry is retried next time.
    }
    secureCache.set(key, null);
  }
  localRemove(key);
}
