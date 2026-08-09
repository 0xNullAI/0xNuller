/**
 * Base URL for the backend APIs.
 *
 * Every backend hangs off the same domain under different paths
 * (`/api/auth`, `/api/items`, `/api/realtime`, `/ws`), so the web build
 * must not hard-code any absolute URL — same-origin relative paths follow
 * whatever deployment is serving the page: preview environments,
 * `wrangler dev`, and production all work with zero config.
 *
 * The Tauri shell is different: its origin is a local scheme (something
 * like `tauri://localhost`), so same-origin relative paths hit the
 * WebView's own asset server. Android therefore needs absolute URLs.
 *
 * This difference bit for real in trial voice: `buildWsUrl` composed a
 * same-origin wss from `location.host` — fine on the web, but on a phone it
 * dialed `wss://tauri.localhost/api/realtime`. And Android has no hot
 * update, so the broken build would have lived on users' phones for a long
 * time.
 */

const PRODUCTION_ORIGIN = 'https://0xnullai.com';

function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  return '__TAURI_INTERNALS__' in window;
}

/**
 * Prefix for HTTP APIs. Empty string on the web (same-origin); absolute
 * origin in the Tauri shell.
 *
 * Override with `VITE_API_BASE_URL` — self-hosted deployments point it at
 * their own domain.
 */
export function apiBaseUrl(): string {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  const override = env?.VITE_API_BASE_URL?.replace(/\/$/, '');
  if (override) return override;
  return isTauri() ? PRODUCTION_ORIGIN : '';
}

/**
 * Full URL for a WebSocket API.
 *
 * On the web it follows the page protocol: an https page must use wss —
 * mixing gets blocked by the browser outright, and the error message only
 * says "connection failed", nothing near the real cause.
 */
export function apiWsUrl(path: string): string {
  const base = apiBaseUrl();
  if (base) return `${base.replace(/^http/, 'ws')}${path}`;
  if (typeof location === 'undefined') return `${PRODUCTION_ORIGIN.replace(/^http/, 'ws')}${path}`;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path}`;
}
