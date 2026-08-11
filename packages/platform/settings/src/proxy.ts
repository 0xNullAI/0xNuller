/**
 * Global proxy settings.
 *
 * One limitation that must be stated plainly: the web build cannot do
 * SOCKS. Browsers do not let a page pick its own proxy — that is an OS or
 * browser-level setting, and page JavaScript has no such capability. Giving
 * the web build a SOCKS toggle means shipping a control that looks usable
 * and never takes effect, which is worse than not having it.
 *
 * Hence the split:
 * - HTTP reverse-proxy base URL: works in both web and the Tauri shell.
 *   Point requests at your own reverse proxy and let it forward. This is
 *   the only viable "use a proxy" path on the web.
 * - SOCKS / system proxy: Tauri shell only (its native HTTP client can be
 *   configured with a proxy). Ignored on the web; the UI must say so.
 *
 * `runtime` is injected by the host: 'web' for the web build, 'tauri' for
 * the shell. It decides which items actually apply, instead of making the
 * user guess.
 */

export type ProxyRuntime = 'web' | 'tauri';

export interface ProxySettings {
  /** Master switch. When off, everything connects directly. */
  enabled: boolean;
  /**
   * HTTP reverse-proxy base URL (with scheme and port), e.g.
   * `http://127.0.0.1:8080`. Empty = do not rewrite request URLs. Applies
   * in both runtimes.
   */
  httpBaseUrl: string;
  /**
   * SOCKS proxy, e.g. `socks5://127.0.0.1:1080`.
   * Tauri shell only — ignored on the web.
   */
}

export const DEFAULT_PROXY: ProxySettings = {
  enabled: false,
  httpBaseUrl: '',
};

const KEY = '0xnullai.proxy';
const listeners = new Set<(s: ProxySettings) => void>();

function coerce(raw: unknown): ProxySettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PROXY };
  const o = raw as Record<string, unknown>;
  return {
    enabled: o.enabled === true,
    httpBaseUrl: typeof o.httpBaseUrl === 'string' ? o.httpBaseUrl : '',
  };
}

export function loadProxy(): ProxySettings {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_PROXY };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return coerce(JSON.parse(raw));
  } catch {
    // On corrupt storage treat as direct connection — failing this way
    // never sends requests somewhere unexpected.
  }
  return { ...DEFAULT_PROXY };
}

export function saveProxy(next: ProxySettings): ProxySettings {
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // If the write fails the values still apply for this session.
  }
  for (const l of listeners) l(next);
  return next;
}

export function updateProxy(updater: (prev: ProxySettings) => ProxySettings): ProxySettings {
  return saveProxy(updater(loadProxy()));
}

export function subscribeProxy(listener: (s: ProxySettings) => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) listener(loadProxy());
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/**
 * Rewrite an upstream URL to go through the reverse proxy.
 *
 * Disabled, unconfigured, or malformed input returns the URL unchanged — a
 * broken proxy config should look like "proxy not used", never like
 * requests going to a mistyped destination.
 */
export function applyHttpProxy(url: string, proxy: ProxySettings = loadProxy()): string {
  return applyReverseProxy(url, proxy, 'http');
}

/** Rewrite a realtime WebSocket URL through the same global reverse proxy. */
export function applyWebSocketProxy(url: string, proxy: ProxySettings = loadProxy()): string {
  return applyReverseProxy(url, proxy, 'websocket');
}

function applyReverseProxy(
  url: string,
  proxy: ProxySettings,
  transport: 'http' | 'websocket',
): string {
  if (!proxy.enabled || !proxy.httpBaseUrl.trim()) return url;
  try {
    const base = new URL(proxy.httpBaseUrl.trim());
    const target = new URL(url);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(base.protocol)) return url;
    if (
      (transport === 'http' && !['http:', 'https:'].includes(target.protocol)) ||
      (transport === 'websocket' && !['ws:', 'wss:'].includes(target.protocol))
    ) {
      return url;
    }
    // Reverse-proxy convention: mount the upstream host and path under the
    // proxy's path. E.g. http://127.0.0.1:8080 + https://api.x.ai/v1/chat
    //   →  http://127.0.0.1:8080/api.x.ai/v1/chat
    const prefix = base.pathname.replace(/\/$/, '');
    const protocol =
      transport === 'websocket'
        ? base.protocol === 'https:' || base.protocol === 'wss:'
          ? 'wss:'
          : 'ws:'
        : base.protocol;
    return `${protocol}//${base.host}${prefix}/${target.host}${target.pathname}${target.search}`;
  } catch {
    return url;
  }
}

/**
 * Detect the current runtime.
 *
 * Tauri injects `__TAURI_INTERNALS__` on window. When not detected, treat
 * as web — a wrong guess in this direction merely shows SOCKS as
 * "unavailable", which is safer than the opposite.
 */
export function detectProxyRuntime(): ProxyRuntime {
  if (typeof window === 'undefined') return 'web';
  return '__TAURI_INTERNALS__' in window ? 'tauri' : 'web';
}
