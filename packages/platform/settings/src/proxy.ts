/**
 * Global proxy settings.
 *
 * A page cannot choose its own proxy: SOCKS or a system proxy is an OS or browser setting, and
 * neither the web build nor the Android WebView can set one from JavaScript. The only proxy this
 * app offers is an HTTP reverse-proxy base URL: requests are rewritten to go through it and the
 * proxy forwards them upstream.
 *
 * The Android shell only lets https (and wss) traffic out: its release CSP allows no other
 * remote scheme and cleartext traffic is disabled. A plain http proxy or custom model endpoint
 * would be blocked there, so the shell accepts https addresses only.
 */

export interface ProxySettings {
  /** Master switch. When off, everything connects directly. */
  enabled: boolean;
  /**
   * HTTP reverse-proxy base URL (with scheme and port), e.g.
   * `http://127.0.0.1:8080`. Empty = do not rewrite request URLs. https only in the
   * Android shell.
   */
  httpBaseUrl: string;
}

export const DEFAULT_PROXY: ProxySettings = {
  enabled: false,
  httpBaseUrl: '',
};

const KEY = '0xnullai.proxy';
let volatileProxy: ProxySettings | null = null;
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
  if (volatileProxy) return { ...volatileProxy };
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
  const normalized = coerce(next);
  try {
    localStorage.setItem(KEY, JSON.stringify(normalized));
    volatileProxy = null;
  } catch {
    // Keep the setting effective for this session even when storage is unavailable.
    volatileProxy = normalized;
  }
  for (const l of listeners) l(normalized);
  return normalized;
}

export function updateProxy(updater: (prev: ProxySettings) => ProxySettings): ProxySettings {
  return saveProxy(updater(loadProxy()));
}

export function subscribeProxy(listener: (s: ProxySettings) => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    volatileProxy = null;
    listener(loadProxy());
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** True in the Android (Tauri) shell, whose CSP and cleartext ban block plain http. */
export function onlyHttpsEndpointsAllowed(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Whether a proxy or custom endpoint address can actually be reached from this runtime. */
export function isUsableEndpointUrl(
  value: string,
  httpsOnly: boolean = onlyHttpsEndpointsAllowed(),
): boolean {
  try {
    const url = new URL(value.trim());
    if (!url.host) return false;
    return url.protocol === 'https:' || (!httpsOnly && url.protocol === 'http:');
  } catch {
    return false;
  }
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
  if (!proxy.enabled || !isUsableEndpointUrl(proxy.httpBaseUrl)) return url;
  try {
    const base = new URL(proxy.httpBaseUrl.trim());
    const target = new URL(url);
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
