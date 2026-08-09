import { useEffect, useMemo, useState } from 'react';
import { Input } from '@0xnullai/ui';
import {
  detectProxyRuntime,
  loadProxy,
  socksSupported,
  subscribeProxy,
  updateProxy,
  type ProxySettings,
} from '@0xnullai/settings';

/**
 * Proxy.
 *
 * The UI has to spell out that "SOCKS is impossible on the web" instead of handing
 * the user a disabled input and letting them guess. Browsers do not let a page pick
 * its own proxy — that is an OS- or browser-level setting, and JavaScript in the
 * page has no such capability. All it can do is point requests at your own HTTP
 * reverse proxy.
 */
export function ProxySection() {
  const [proxy, setProxy] = useState<ProxySettings>(loadProxy);
  const runtime = useMemo(() => detectProxyRuntime(), []);
  const canSocks = socksSupported(runtime);

  useEffect(() => subscribeProxy(setProxy), []);

  function patch(p: Partial<ProxySettings>) {
    setProxy(updateProxy((prev) => ({ ...prev, ...p })));
  }

  return (
    <section className="rounded-[14px] border border-[var(--surface-border)] p-4">
      <label className="flex items-center justify-between gap-4">
        <span>
          <span className="block text-sm font-semibold">代理</span>
          <span className="block text-xs text-[var(--text-faint)]">
            影响全部模型请求（文本与语音）
          </span>
        </span>
        <input
          type="checkbox"
          checked={proxy.enabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
          className="accent-[var(--accent)]"
        />
      </label>

      {proxy.enabled && (
        <div className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-[var(--text-soft)]">HTTP 反代地址</span>
            <Input
              value={proxy.httpBaseUrl}
              onChange={(e) => patch({ httpBaseUrl: e.target.value })}
              placeholder="http://127.0.0.1:8080"
            />
            <span className="text-xs text-[var(--text-faint)]">
              请求会改写成 <code>反代地址/上游域名/原路径</code>，由你的反代转发。留空则不改写。
            </span>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="flex items-center gap-2 text-xs text-[var(--text-soft)]">
              SOCKS 代理
              {!canSocks && (
                <span className="rounded-full bg-[var(--bg-soft)] px-1.5 py-0.5 text-[10px] text-[var(--text-faint)]">
                  网页端不可用
                </span>
              )}
            </span>
            <Input
              value={proxy.socksUrl}
              onChange={(e) => patch({ socksUrl: e.target.value })}
              placeholder="socks5://127.0.0.1:1080"
              disabled={!canSocks}
            />
            <span className="text-xs text-[var(--text-faint)]">
              {canSocks
                ? '由客户端的原生网络栈使用。'
                : '浏览器不允许网页自行选择代理，这是操作系统或浏览器的设置。此项只在桌面/安卓客户端里生效——填了在网页端也不会有任何作用，所以这里直接禁用。'}
            </span>
          </label>
        </div>
      )}
    </section>
  );
}
