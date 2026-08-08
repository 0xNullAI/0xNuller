/**
 * 后端接口的基地址。
 *
 * 所有后端都挂在同一个域的不同路径下（`/api/auth` `/api/items` `/api/realtime`
 * `/ws`），所以网页端**不该写任何绝对地址**——同源相对路径自动跟着当前部署走，
 * 预览环境、`wrangler dev`、正式域名都不用改配置。
 *
 * 但 Tauri 壳不行：它的 origin 是本地 scheme（`tauri://localhost` 之类），同源相对
 * 路径会打到 WebView 自己的资源服务上。安卓端因此必须用绝对地址。
 *
 * 这个区别曾经在体验版语音上真实踩过：`buildWsUrl` 用 `location.host` 拼同源 wss，
 * 网页上完全正常，装到手机上连出去的是 `wss://tauri.localhost/api/realtime`。
 * 而安卓没有热更新——坏掉的那版会长期留在用户手机上。
 */

const PRODUCTION_ORIGIN = 'https://0xnullai.com';

function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  return '__TAURI_INTERNALS__' in window;
}

/**
 * HTTP 接口的前缀。网页端返回空串（同源），Tauri 壳返回绝对 origin。
 *
 * 用 `VITE_API_BASE_URL` 覆盖——自建部署时指向自己的域名。
 */
export function apiBaseUrl(): string {
  const override = (import.meta.env?.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '');
  if (override) return override;
  return isTauri() ? PRODUCTION_ORIGIN : '';
}

/**
 * WebSocket 接口的完整地址。
 *
 * 网页端跟随当前页面的协议：https 页面必须用 wss，混用会被浏览器直接拦掉，
 * 而报错信息只说「连接失败」，跟真正的原因对不上。
 */
export function apiWsUrl(path: string): string {
  const base = apiBaseUrl();
  if (base) return `${base.replace(/^http/, 'ws')}${path}`;
  if (typeof location === 'undefined') return `${PRODUCTION_ORIGIN.replace(/^http/, 'ws')}${path}`;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path}`;
}
