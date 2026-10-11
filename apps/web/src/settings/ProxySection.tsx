import { useEffect, useState } from 'react';
import { Input, Switch } from '@0xnullai/ui';
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
    <section aria-label="AI 网络代理">
      <div className="flex items-center justify-between gap-4">
        <h4 className="text-sm font-semibold">AI 网络代理</h4>
        <Switch
          label="AI 网络代理"
          checked={proxy.enabled}
          disabled={!proxy.enabled && !validUrl}
          onCheckedChange={(enabled) => patch({ enabled })}
        />
      </div>

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
