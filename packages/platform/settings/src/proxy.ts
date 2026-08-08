/**
 * 全局代理设置。
 *
 * **一条必须说清楚的限制：网页端做不到 SOCKS。** 浏览器不允许页面自行选择代理——
 * 那是操作系统或浏览器层的设置，页面里的 JavaScript 没有这个能力。给网页端一个
 * SOCKS 开关等于给一个看起来能用、实际永远不生效的按钮，那比没有更糟。
 *
 * 所以这里区分两件事：
 * - **HTTP 反代地址**：网页端与 Tauri 壳都能用。把请求指向你自己的反代，由它转发。
 *   这是网页端唯一可行的「走代理」方式。
 * - **SOCKS / 系统代理**：只有 Tauri 壳能用（原生 HTTP 客户端可以配置代理）。
 *   网页端这一项会被忽略，界面上必须标明。
 *
 * `runtime` 由宿主注入：网页端是 'web'，Tauri 壳是 'tauri'。它决定哪些项真正生效，
 * 而不是让用户去猜。
 */

export type ProxyRuntime = 'web' | 'tauri';

export interface ProxySettings {
  /** 是否启用。关闭时全部按直连处理。 */
  enabled: boolean;
  /**
   * HTTP 反代地址（含协议与端口），例如 `http://127.0.0.1:8080`。
   * 留空表示不改写请求地址。两种运行时都生效。
   */
  httpBaseUrl: string;
  /**
   * SOCKS 代理，例如 `socks5://127.0.0.1:1080`。
   * **只在 Tauri 壳里生效**，网页端会被忽略。
   */
  socksUrl: string;
}

export const DEFAULT_PROXY: ProxySettings = {
  enabled: false,
  httpBaseUrl: '',
  socksUrl: '',
};

const KEY = '0xnullai.proxy';
const listeners = new Set<(s: ProxySettings) => void>();

function coerce(raw: unknown): ProxySettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PROXY };
  const o = raw as Record<string, unknown>;
  return {
    enabled: o.enabled === true,
    httpBaseUrl: typeof o.httpBaseUrl === 'string' ? o.httpBaseUrl : '',
    socksUrl: typeof o.socksUrl === 'string' ? o.socksUrl : '',
  };
}

export function loadProxy(): ProxySettings {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_PROXY };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return coerce(JSON.parse(raw));
  } catch {
    // 存储被污染时按直连处理——这个方向的失败不会把请求发到意料之外的地方。
  }
  return { ...DEFAULT_PROXY };
}

export function saveProxy(next: ProxySettings): ProxySettings {
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // 存不下时本次会话内仍然生效。
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
 * 把一个上游地址改写成经由反代的地址。
 *
 * 未启用、未配置、或地址本身不合法时**原样返回**——代理配置错了应该表现为「没走
 * 代理」，而不是把请求发到一个拼错的地方。
 */
export function applyHttpProxy(url: string, proxy: ProxySettings = loadProxy()): string {
  if (!proxy.enabled || !proxy.httpBaseUrl.trim()) return url;
  try {
    const base = new URL(proxy.httpBaseUrl.trim());
    const target = new URL(url);
    // 反代约定：把上游的 host 与路径整体挂到反代的路径下。
    // 例如 http://127.0.0.1:8080 + https://api.x.ai/v1/chat
    //   →  http://127.0.0.1:8080/api.x.ai/v1/chat
    const prefix = base.pathname.replace(/\/$/, '');
    return `${base.origin}${prefix}/${target.host}${target.pathname}${target.search}`;
  } catch {
    return url;
  }
}

/** 当前运行时能不能真正使用 SOCKS。网页端恒为 false。 */
export function socksSupported(runtime: ProxyRuntime): boolean {
  return runtime === 'tauri';
}

/**
 * 判断当前运行时。
 *
 * Tauri 会在 window 上注入 `__TAURI_INTERNALS__`。检测不到就按网页端处理——
 * 这个方向的误判只会让 SOCKS 项显示为「不可用」，比反过来安全。
 */
export function detectProxyRuntime(): ProxyRuntime {
  if (typeof window === 'undefined') return 'web';
  return '__TAURI_INTERNALS__' in window ? 'tauri' : 'web';
}
