import { useEffect, useState } from 'react';
import { Input } from '@0xnullai/ui';
import {
  isValidHttpProxyBaseUrl,
  loadProxy,
  subscribeProxy,
  updateProxy,
  type ProxySettings,
} from '@0xnullai/settings';

export function ProxySection() {
  const [proxy, setProxy] = useState<ProxySettings>(loadProxy);

  useEffect(() => subscribeProxy(setProxy), []);

  function patch(p: Partial<ProxySettings>) {
    setProxy(updateProxy((prev) => ({ ...prev, ...p })));
  }

  const validUrl = isValidHttpProxyBaseUrl(proxy.httpBaseUrl);

  return (
    <section className="rounded-[var(--radius-md)] border border-[var(--surface-border)] p-4">
      <label className="flex items-center justify-between gap-4">
        <span className="text-sm font-semibold">AI 网络代理</span>
        <input
          type="checkbox"
          checked={proxy.enabled}
          disabled={!proxy.enabled && !validUrl}
          onChange={(e) => patch({ enabled: e.target.checked })}
          className="accent-[var(--accent)]"
        />
      </label>

      <p className="mt-1 text-xs leading-5 text-[var(--text-soft)]">
        Agent、Voice 和 Video 共用此代理，无需分别设置。
      </p>

      <label className="mt-3 flex flex-col gap-1.5">
        <span className="text-xs text-[var(--text-soft)]">反向代理地址</span>
        <Input
          value={proxy.httpBaseUrl}
          onChange={(event) => {
            const httpBaseUrl = event.target.value;
            patch({
              httpBaseUrl,
              ...(proxy.enabled && !isValidHttpProxyBaseUrl(httpBaseUrl) ? { enabled: false } : {}),
            });
          }}
          placeholder="http://127.0.0.1:8080"
          aria-invalid={proxy.httpBaseUrl.length > 0 && !validUrl}
        />
      </label>
      {proxy.httpBaseUrl.length > 0 && !validUrl && (
        <p role="alert" className="mt-2 text-xs text-[var(--danger)]">
          请输入有效的 HTTP 或 HTTPS 地址
        </p>
      )}
    </section>
  );
}
